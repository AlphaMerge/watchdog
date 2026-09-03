import { useCallback, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, send } from '../../api/client';
import type { SettingSource, SettingView } from '../../api/types';
import { Empty } from '../../components/Panels';
import { SchemaControl } from '../../forms/Control';
import { labelFor } from '../../forms/schema';
import { problemsFor } from '../../forms/validate';
import { fieldFor } from './model';

/**
 * Every inheritable setting in effect, with an override toggle (`U-09`).
 *
 * **The source is the half that matters, and it is why the toggle is a toggle and not an input.**
 * "60 seconds" is not the same fact as "60 seconds, because the group two levels up says so".
 * An operator who changes the wrong object is what happens when only the value is shown: they set
 * it here, it appears to work, and the next sensor added to that group behaves differently for
 * reasons nobody can find.
 *
 * **Overridden-to-the-same-value is a real state and is kept distinct.** `own: { value: 60 }` on
 * an object whose parent also says 60 means the toggle is *on* — and it matters, because when the
 * parent later changes to 30 this object stays at 60. Collapsing the two by comparing values
 * would silently turn a deliberate pin into a follower.
 *
 * Controls come from `U-08`'s renderer, generated from each setting's own schema, so the bounds
 * an operator is held to here are the ones the registry declares.
 */
export function SettingsPanel({
  objectId,
  items,
  ancestors,
  onChanged,
}: {
  objectId: number;
  items: readonly SettingView[];
  /** Root first. Used only to name the object a value came from — the API gives an id. */
  ancestors: readonly { id: number; name: string }[] | null;
  onChanged: () => void;
}): React.JSX.Element {
  if (items.length === 0) {
    return <Empty because="Nothing inheritable applies to this kind.">No settings.</Empty>;
  }

  const groups = new Map<string, SettingView[]>();
  for (const setting of items) {
    const prefix = setting.key.split('.')[0] ?? 'other';
    const held = groups.get(prefix);
    if (held === undefined) groups.set(prefix, [setting]);
    else held.push(setting);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([prefix, settings]) => (
        <section key={prefix} className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{prefix}</h3>
          {settings.map((setting) => (
            <Setting
              key={setting.key}
              objectId={objectId}
              setting={setting}
              prefix={prefix}
              ancestors={ancestors}
              onChanged={onChanged}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function Setting({
  objectId,
  setting,
  prefix,
  ancestors,
  onChanged,
}: {
  objectId: number;
  setting: SettingView;
  prefix: string;
  ancestors: readonly { id: number; name: string }[] | null;
  onChanged: () => void;
}): React.JSX.Element {
  const id = useId();
  const overridden = setting.own !== null;
  const [draft, setDraft] = useState<unknown>(setting.own?.value ?? setting.inherited.value);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);

  const field = fieldFor(setting, prefix);
  const problems = problemsFor(field, draft);
  const dirty = overridden && JSON.stringify(draft) !== JSON.stringify(setting.own?.value);

  const run = useCallback(
    (work: () => Promise<unknown>) => {
      setBusy(true);
      setFailed(null);
      work()
        .then(onChanged)
        .catch((error: unknown) => {
          setFailed(
            error instanceof ApiError
              ? error
              : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'),
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [onChanged],
  );

  const override = (on: boolean): void => {
    if (on) {
      // Turning it on writes the value it currently shows, so the pin is immediate and explicit
      // rather than a state that exists only in this browser until somebody types something.
      run(() =>
        send('PUT', `/objects/${String(objectId)}/settings/${setting.key}`, {
          value: setting.inherited.value,
        }),
      );
      setDraft(setting.inherited.value);
    } else {
      // Reverting discards the local value. The server decides what is inherited afterwards; the
      // draft follows what the API said would be restored.
      run(() => send('DELETE', `/objects/${String(objectId)}/settings/${setting.key}`));
      setDraft(setting.inherited.value);
    }
  };

  return (
    <div className="space-y-1.5 rounded border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {labelFor(setting.key.slice(prefix.length + 1))}
        </label>
        <span className="font-mono text-xs text-text-muted">{setting.key}</span>
        <Origin source={setting.effective.source} ancestors={ancestors} />
      </div>

      <p className="text-xs text-text-muted">{setting.description}</p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-6 items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={overridden}
            disabled={busy}
            onChange={(event) => {
              override(event.target.checked);
            }}
          />
          Override here
        </label>

        {overridden ? (
          <>
            <SchemaControl
              id={id}
              field={field}
              value={draft}
              disabled={busy}
              describedBy=""
              invalid={problems.length > 0}
              onValue={setDraft}
              onBlur={() => undefined}
            />
            <button
              type="button"
              disabled={busy || !dirty || problems.length > 0}
              onClick={() => {
                run(() =>
                  send('PUT', `/objects/${String(objectId)}/settings/${setting.key}`, {
                    value: draft,
                  }),
                );
              }}
              className="rounded border border-accent px-2 py-1 text-xs text-accent disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          // Disabled rather than absent: the value is the fact an operator came to read, and
          // hiding it behind the toggle would make them turn the toggle on to find out what they
          // are about to override.
          <>
            <SchemaControl
              id={id}
              field={field}
              value={setting.inherited.value}
              disabled
              describedBy=""
              invalid={false}
              onValue={() => undefined}
              onBlur={() => undefined}
            />
            <span className="text-xs text-text-muted">inherited</span>
          </>
        )}
      </div>

      {overridden && (
        <p className="text-xs text-text-muted">
          Reverting restores <span className="font-mono">{show(setting.inherited.value)}</span>,
          from {nameOf(setting.inherited.source, ancestors)}.
        </p>
      )}

      {problems.length > 0 && (
        <p className="text-xs text-down-fg">
          {problems.map((problem) => problem.message).join('; ')}
        </p>
      )}
      {failed !== null && <p className="text-xs text-down-fg">{failed.message}</p>}
    </div>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string') return value === '' ? '""' : value;
  return JSON.stringify(value);
}

function nameOf(
  source: SettingSource,
  ancestors: readonly { id: number; name: string }[] | null,
): string {
  if (source.kind === 'default') return 'the registry default';
  const named = ancestors?.find((ancestor) => ancestor.id === source.objectId);
  return named?.name ?? `#${String(source.objectId)}`;
}

/** Where a value came from. Text, not a colour: this is the part an operator has to act on. */
function Origin({
  source,
  ancestors,
}: {
  source: SettingSource;
  ancestors: readonly { id: number; name: string }[] | null;
}): React.JSX.Element {
  if (source.kind === 'own') return <span className="text-xs text-accent">set here</span>;
  if (source.kind === 'default') {
    return <span className="text-xs text-text-muted">registry default</span>;
  }
  // An inheritable value can only come from an ancestor, so the breadcrumb already holds every
  // name this could need. Falling back to the id keeps it honest if that ever stops being true.
  return (
    <Link
      to={`/objects/${String(source.objectId)}?tab=settings`}
      className="text-xs text-accent hover:underline"
    >
      inherited from {nameOf(source, ancestors)}
    </Link>
  );
}
