import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, request, send, useApi, type Loadable } from '../../api/client';
import type {
  CredentialKindSummary,
  CredentialRemoval,
  CredentialView,
  CredentialWrite,
  EffectiveAccess,
  ObjectRef,
} from '../../api/types';
import { useSession } from '../../auth/session';
import { Card, CorrelationId, Empty, ErrorPanel, Loading } from '../../components/Panels';
import { SchemaForm } from '../../forms/SchemaForm';
import { fieldsOf, readAt } from '../../forms/schema';
import { allProblems, type FieldProblem } from '../../forms/validate';
import {
  OUTSIDE_MEANS,
  UNBOUNDED_PATH,
  asksForRight,
  boundsSentence,
  clearedSentence,
  draftFor,
  isDirty,
  kindName,
  kindsToAdd,
  mayWrite,
  needsConfirmation,
  ownerName,
  ownerOf,
  publicRows,
  refusedFields,
  removalSentence,
  savedSentence,
  schemaOf,
  secretChangeSentence,
  secretChanges,
  secretLabels,
  type Owner,
} from './credentials-model';

const BUTTON =
  'border border-border px-2 py-1 text-sm text-text hover:bg-surface disabled:opacity-50';
const PRIMARY =
  'border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50';

function asApiError(error: unknown, fallback: string): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : fallback);
}

/**
 * The credential sets in force on a probe, a group or a device (`U-21`).
 *
 * **Until this existed a set could be written only with `curl`**, and an operator learned which
 * sets had no bounds from a number on Core Health. The tab shows what the object stores and what
 * it inherits, says which of them go wherever somebody vouches for, and lets somebody with `write`
 * store, change and remove one.
 *
 * **A secret is never here to show.** The core returns the public half of a set and the names of
 * the secrets it holds, to anyone, administrators included. The form offers keep, replace and
 * clear for each, and sends a secret only when one was typed.
 *
 * **A save is asked about before it is made.** Narrowing a set's bounds takes every sensor outside
 * them to Unknown, and widening them clears the password. The core answers both for a write that
 * is run and rolled back (`?dryRun=true`), on the route that writes, so what is shown before the
 * confirmation is what the write then does. A removal is asked about the same way.
 */
export function CredentialsPanel({
  object,
  ancestors,
}: {
  object: { id: number; name: string; kind: string };
  /** The breadcrumb, root first and trimmed to what the reader can see; null while it loads. */
  ancestors: readonly ObjectRef[] | null;
}): React.JSX.Element {
  const { session } = useSession();
  const base = `/objects/${String(object.id)}`;
  const { sets, reload, reloading, stale } = useSets(`${base}/credentials`);
  const kinds = useApi<{ items: CredentialKindSummary[] }>('/credential-kinds');
  const access = useApi<EffectiveAccess>(asksForRight(session) ? `${base}/access/effective` : null);
  const canWrite = mayWrite(session, access);

  /** The kind whose form is open: an own set being edited, or a new one being written. */
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  /** What the last save or removal did, in the core's numbers. Announced, and left on screen. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  /** The kind whose removal is being checked or confirmed. One thing is asked about at a time. */
  const [asking, setAsking] = useState<string | null>(null);
  /**
   * The control a form closed unsaved goes back to: a kind's Edit button, or the Add button.
   * Without it focus falls to the document body, and a keyboard user starts the page again.
   */
  const [returnTo, setReturnTo] = useState<{ edit: string } | 'add' | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returned = useCallback(() => {
    setReturnTo(null);
  }, []);
  useEffect(() => {
    if (returnTo !== 'add') return;
    addButton.current?.focus();
    setReturnTo(null);
  }, [returnTo]);

  const finished = useCallback(
    (said: string) => {
      setEditing(null);
      setNotice(said);
      reload();
      // The form or the confirmation that held focus is gone, so focus goes to what happened
      // rather than back to the top of the document.
      noticeRef.current?.focus();
    },
    [reload],
  );

  if (sets.status === 'loading' || kinds.status === 'loading') {
    return <Loading what="credentials" />;
  }
  if (sets.status === 'error') return <ErrorPanel error={sets.error} retry={reload} />;
  if (kinds.status === 'error') return <ErrorPanel error={kinds.error} retry={kinds.retry} />;

  const items = sets.data;
  const catalogue = kinds.data.items;
  // **What is on screen is not what is stored**, between a save and the list being read again:
  // a form opened then would be drafted from the set as it was, and saving it would put the old
  // values back. So nothing is opened until the list is the core's again.
  const behind = reloading || stale !== null;
  const addable = kindsToAdd(catalogue, items);
  const chosen = addable.find((kind) => kind.id === adding) ?? addable[0];
  const newKind = catalogue.find(
    (kind) =>
      kind.id === editing &&
      !items.some((set) => set.kind === kind.id && set.source.kind === 'own'),
  );

  return (
    <div className="space-y-4">
      <Card title="Credential sets">
        <p className="text-sm text-text-muted">
          A set stored here is used by every sensor on this {object.kind} and beneath it that needs
          its kind, unless something nearer stores its own. Secrets are never shown, to anyone: each
          is kept, replaced or removed.
        </p>

        {/* Always in the document, so a result is announced when it arrives rather than only
            when the region happens to be new. Focusable, because the control that was used to
            get here has usually just gone. */}
        <p
          ref={noticeRef}
          role="status"
          aria-live="polite"
          tabIndex={-1}
          className={
            notice === null
              ? 'sr-only'
              : 'mt-3 border border-border bg-surface px-3 py-2 text-sm text-text'
          }
        >
          {notice ?? ''}
        </p>

        {/* A save or a removal that was made, and a list that could not be read after it. What
            happened stays said above; this says the list is the old one, and offers to read it. */}
        {stale !== null && (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-text">
              The list below could not be read again, so it may not show the last change. Nothing
              can be changed here until it has been.
            </p>
            <ErrorPanel error={stale} retry={reload} />
          </div>
        )}

        {/* Not while the core is still being asked: the sentence would be up for a moment in
            front of every account that may write. */}
        {!canWrite && !(asksForRight(session) && access.status === 'loading') && (
          <p className="mt-3 text-sm text-text-muted">
            You can read these sets. Changing them needs write on this {object.kind}.
          </p>
        )}

        {catalogue.length === 0 && (
          <div className="mt-3">
            <Empty because="A credential is stored encrypted or not at all. An administrator configures the vault key; see administration.md.">
              This core has no credential vault, so no set can be stored.
            </Empty>
          </div>
        )}

        {catalogue.length > 0 && items.length === 0 && (
          <div className="mt-3">
            <Empty because="Sensors that need credentials here have none to use until a set is stored on this object or above it.">
              No credential sets are in force here.
            </Empty>
          </div>
        )}

        {items.length > 0 && (
          <ul className="mt-3 divide-y divide-border" aria-label="Credential sets">
            {items.map((set) => (
              <SetRow
                key={set.kind}
                object={object}
                set={set}
                kind={catalogue.find((kind) => kind.id === set.kind)}
                name={kindName(catalogue, set.kind)}
                ancestors={ancestors}
                canWrite={canWrite}
                editing={editing === set.kind && set.source.kind === 'own'}
                busyElsewhere={
                  editing !== null || behind || (asking !== null && asking !== set.kind)
                }
                focusEdit={returnTo !== null && returnTo !== 'add' && returnTo.edit === set.kind}
                onFocused={returned}
                onAsking={(open) => {
                  setAsking(open ? set.kind : null);
                }}
                onEdit={() => {
                  setNotice(null);
                  setEditing(set.kind);
                }}
                onCancel={() => {
                  setEditing(null);
                  setReturnTo({ edit: set.kind });
                }}
                onDone={finished}
              />
            ))}
          </ul>
        )}

        {canWrite && newKind !== undefined && (
          <div className="mt-4">
            <CredentialForm
              object={object}
              kind={newKind}
              set={null}
              onCancel={() => {
                setEditing(null);
                setReturnTo('add');
              }}
              onSaved={finished}
            />
          </div>
        )}

        {canWrite && editing === null && chosen !== undefined && (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-sm text-text">
              <span className="block font-medium">Store a set here</span>
              <select
                className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text disabled:opacity-50"
                disabled={behind || asking !== null}
                value={chosen.id}
                onChange={(event) => {
                  setAdding(event.target.value);
                }}
              >
                {addable.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.name}
                    {items.some((set) => set.kind === kind.id)
                      ? ' (overrides the inherited set)'
                      : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              ref={addButton}
              type="button"
              className={BUTTON}
              disabled={behind || asking !== null}
              onClick={() => {
                setNotice(null);
                setEditing(chosen.id);
              }}
            >
              Add {chosen.name} credentials
            </button>
            {/* A removal confirmed while a form is open would take the form with it, unsaved. */}
            {asking !== null && (
              <span className="text-xs text-text-muted">
                Answer the removal above before storing another set.
              </span>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * The sets in force on the object, read again on demand.
 *
 * **Not `useApi`, for one difference: a reload keeps what is on screen until the new answer is
 * in.** `useApi` goes back to `loading`, which would take the list down after every save, and the
 * live region and the focus placed on it with the list. Here the first read is the only one that
 * shows a loading line.
 *
 * **And a reload that fails keeps it too.** The save or the removal before it was made; replacing
 * the tab with an error would take down the sentence that says so. The list stays, `stale` carries
 * the error, and the panel says the list is the old one. Only a first read that fails has nothing
 * to keep.
 */
function useSets(path: string): {
  sets: Loadable<CredentialView[]>;
  reload: () => void;
  /** A read asked for after the first, and not answered yet. */
  reloading: boolean;
  /** Why the list on screen is not the newest: the last read of it failed. */
  stale: ApiError | null;
} {
  const [state, setState] = useState<Loadable<CredentialView[]>>({ status: 'loading' });
  const [stale, setStale] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  /** The read that has been answered. Behind `nonce` while one is in flight. */
  const [answered, setAnswered] = useState(-1);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request<{ items: CredentialView[] }>(path, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        setState({ status: 'ready', data: answer.items });
        setStale(null);
        setAnswered(nonce);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failed = asApiError(error, 'the sets could not be read');
        setState((held) => (held.status === 'ready' ? held : { status: 'error', error: failed }));
        setStale(failed);
        setAnswered(nonce);
      });
    return () => {
      controller.abort();
    };
  }, [path, nonce]);

  return {
    sets: state,
    reload,
    reloading: answered !== nonce,
    stale,
  };
}

/** Where a set is stored. Text and a link, never a colour alone. */
function Origin({ owner }: { owner: Owner }): React.JSX.Element {
  if (owner.kind === 'here') return <span className="text-xs text-accent">stored here</span>;
  if (owner.kind === 'outside') {
    // Stored above the branch this account was granted: it is told so, and not by what (`A-12`).
    return (
      <span className="text-xs text-text-muted">inherited from an object outside your view</span>
    );
  }
  return (
    <Link
      to={`/objects/${String(owner.id)}?tab=credentials`}
      className="text-xs text-accent hover:underline"
    >
      inherited from {owner.name}
    </Link>
  );
}

function SetRow({
  object,
  set,
  kind,
  name,
  ancestors,
  canWrite,
  editing,
  busyElsewhere,
  focusEdit,
  onFocused,
  onAsking,
  onEdit,
  onCancel,
  onDone,
}: {
  object: { id: number; name: string; kind: string };
  set: CredentialView;
  /** Absent when this build's catalogue has no such kind: shown, and not editable. */
  kind: CredentialKindSummary | undefined;
  name: string;
  ancestors: readonly ObjectRef[] | null;
  canWrite: boolean;
  editing: boolean;
  busyElsewhere: boolean;
  /** This row's form has just closed unsaved: focus goes back to the button that opened it. */
  focusEdit: boolean;
  onFocused: () => void;
  onAsking: (open: boolean) => void;
  onEdit: () => void;
  onCancel: () => void;
  onDone: (said: string) => void;
}): React.JSX.Element {
  const owner = ownerOf(set.source, object.id, ancestors);
  const own = owner.kind === 'here';
  const rows = kind === undefined ? [] : publicRows(schemaOf(kind), set.publicParams);
  const secrets = kind === undefined ? [] : secretLabels(schemaOf(kind), set.secretsSet ?? []);
  const trusted = ownerName(owner, object);

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-text">{name}</h3>
        <Origin owner={owner} />
        {set.bounded ? (
          <span className="border border-border px-1.5 py-0.5 text-xs text-text-muted">
            Bounded
          </span>
        ) : (
          <span className="border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning-fg">
            <span aria-hidden="true">! </span>No bounds
          </span>
        )}
        <time
          dateTime={set.updatedAt}
          title={set.updatedAt}
          className="font-mono text-xs text-text-muted"
        >
          changed {new Date(set.updatedAt).toLocaleString()}
        </time>
      </div>

      {set.bounded ? (
        <p className="text-xs text-text-muted">
          It goes to the devices inside its bounds, whoever created them, and to no other.
        </p>
      ) : (
        <p className="text-sm text-text">
          This set has no allowed targets{set.kind === 'ssh' ? ' and lists no host keys' : ''}, so
          write on {trusted} is trust with it: whoever may write there can send it to any device
          they can put beneath it.{' '}
          <Link to={UNBOUNDED_PATH} className="text-accent hover:underline">
            Every set without bounds
          </Link>
        </p>
      )}

      {rows.length > 0 && (
        <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.name} className="contents">
              <dt className="text-text-muted">{row.label}</dt>
              <dd className="break-words font-mono text-xs text-text">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {own && (
        <p className="text-xs text-text-muted">
          {secrets.length === 0
            ? 'No secret is stored in this set.'
            : `Stored and never shown: ${secrets.join(', ')}.`}
        </p>
      )}

      {own && canWrite && !editing && (
        <SetActions
          object={object}
          set={set}
          name={name}
          editable={kind !== undefined}
          ancestors={ancestors}
          disabled={busyElsewhere}
          focusEdit={focusEdit}
          onFocused={onFocused}
          onAsking={onAsking}
          onEdit={onEdit}
          onRemoved={onDone}
        />
      )}

      {own && canWrite && editing && kind !== undefined && (
        <CredentialForm
          object={object}
          kind={kind}
          set={set}
          onCancel={onCancel}
          onSaved={onDone}
        />
      )}
    </li>
  );
}

/**
 * Edit and remove, for a set stored on this object.
 *
 * **Removing asks the core what would lose the set before it asks the operator** — the same
 * removal, rolled back. So the confirmation names a number of sensors and what they use instead,
 * and a removal the core would refuse (`A-41`: the set that comes back into force needs somebody
 * to vouch for it) is refused here, before anything is confirmed.
 */
function SetActions({
  object,
  set,
  name,
  editable,
  ancestors,
  disabled,
  focusEdit,
  onFocused,
  onAsking,
  onEdit,
  onRemoved,
}: {
  object: { id: number; name: string; kind: string };
  set: CredentialView;
  name: string;
  editable: boolean;
  ancestors: readonly ObjectRef[] | null;
  disabled: boolean;
  focusEdit: boolean;
  onFocused: () => void;
  /** Told while this row's removal is being checked or confirmed, so nothing else is opened. */
  onAsking: (open: boolean) => void;
  onEdit: () => void;
  onRemoved: (said: string) => void;
}): React.JSX.Element {
  const path = `/objects/${String(object.id)}/credentials/${set.kind}`;
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<CredentialRemoval | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  /** The confirmation was dismissed or refused, and focus is owed to the button that opened it. */
  const [backToRemove, setBackToRemove] = useState(false);

  useEffect(() => {
    if (asked !== null) confirmation.current?.focus();
  }, [asked]);
  useEffect(() => {
    if (!backToRemove || asked !== null) return;
    removeButton.current?.focus();
    setBackToRemove(false);
  }, [backToRemove, asked]);
  useEffect(() => {
    if (!focusEdit) return;
    editButton.current?.focus();
    onFocused();
  }, [focusEdit, onFocused]);

  /** Closes the confirmation without removing, and puts focus back where it was opened from. */
  const dismiss = (): void => {
    setAsked(null);
    setBackToRemove(true);
    onAsking(false);
  };

  const ask = (): void => {
    setBusy(true);
    setFailure(null);
    onAsking(true);
    send<CredentialRemoval>('DELETE', `${path}?dryRun=true`)
      .then(setAsked)
      .catch((error: unknown) => {
        setFailure(asApiError(error, 'the set could not be checked'));
        onAsking(false);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = (): void => {
    setBusy(true);
    setFailure(null);
    send<CredentialRemoval>('DELETE', path)
      .then((outcome) => {
        setAsked(null);
        setBusy(false);
        onAsking(false);
        onRemoved(
          `Removed the ${name} set from ${object.name}. ` +
            removalSentence(name, object, outcome, ancestors, 'now'),
        );
      })
      .catch((error: unknown) => {
        setFailure(asApiError(error, 'the set could not be removed'));
        setBusy(false);
        dismiss();
      });
  };

  return (
    // Not a stack: the refusal under the buttons is always there, and `space-y-*` would put a
    // margin under whatever is above it while it says nothing (`U-52`). It brings its own.
    <div>
      {asked === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <button
              ref={editButton}
              type="button"
              className={BUTTON}
              disabled={disabled || busy}
              onClick={onEdit}
            >
              Edit <span className="sr-only">{name} credentials</span>
            </button>
          )}
          <button
            ref={removeButton}
            type="button"
            className={BUTTON}
            disabled={disabled || busy}
            onClick={ask}
          >
            {busy ? 'Checking…' : 'Remove'} <span className="sr-only">{name} credentials</span>
          </button>
        </div>
      ) : (
        <div
          ref={confirmation}
          tabIndex={-1}
          role="group"
          aria-label={`Confirm removing ${name} credentials`}
          className="space-y-2 border border-down-border bg-down-bg px-3 py-2 text-sm text-down-fg"
        >
          <p className="font-medium">
            Remove the {name} set from {object.name}?
          </p>
          <p>{removalSentence(name, object, asked, ancestors, 'will')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={remove}
              className="border border-down-fg px-2 py-1 text-sm text-down-fg hover:bg-surface disabled:opacity-50"
            >
              {busy ? 'Removing…' : 'Remove the set'}
            </button>
            <button type="button" disabled={busy} onClick={dismiss} className={BUTTON}>
              Keep it
            </button>
          </div>
        </div>
      )}
      <Refusal error={failure} className="mt-2 empty:mt-0" />
    </div>
  );
}

/**
 * A refused check, save or removal (`U-54`).
 *
 * **Always rendered, empty until there is a refusal**, as `U-48` and `U-52` did: focus is on the
 * button that was used when the core refuses, and a region added with its text already in it is
 * not reliably announced (`U-41`). Each attempt empties it as it starts, so a second refusal in
 * the same words is a change and is said again. The caller gives the margin with its `empty:`
 * twin, so it takes no space while it says nothing (`U-45`).
 */
function Refusal({
  error,
  className,
}: {
  error: ApiError | null;
  className: string;
}): React.JSX.Element {
  return (
    <p role="alert" className={`text-sm text-down-fg ${className}`}>
      {error?.message}
      <CorrelationId id={error?.correlationId} size="text-xs" />
    </p>
  );
}

/**
 * One set's form, generated from its kind's schema.
 *
 * **Nothing here knows a kind.** The fields, their order, their descriptions, which are secrets,
 * `allowedTargets` and SSH's `hostKeys` all come from `GET /credential-kinds`, the schema the
 * vault validates a write against. A kind added to the catalogue has a form the day it has a
 * schema.
 *
 * **Saving is two requests when the first one has something to say.** The save is previewed; if
 * it puts a sensor outside the set's bounds that was inside them (`A-55`: not one that was
 * outside already), or clears a secret, the form stops and says so, and the fields are held as
 * they were previewed until the operator confirms or goes back.
 */
function CredentialForm({
  object,
  kind,
  set,
  onSaved,
  onCancel,
}: {
  object: { id: number; name: string; kind: string };
  kind: CredentialKindSummary;
  /** The set stored on this object, or null for a new one. */
  set: CredentialView | null;
  onSaved: (said: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const headingId = useId();
  const schema = useMemo(() => schemaOf(kind), [kind]);
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const stored = useMemo(() => set?.secretsSet ?? [], [set]);
  const path = `/objects/${String(object.id)}/credentials/${kind.id}`;

  const [values, setValues] = useState<Record<string, unknown>>(() => draftFor(schema, set));
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'checking' | 'saving' | null>(null);
  /** A previewed save waiting to be confirmed. The fields are held while it is. */
  const [pending, setPending] = useState<CredentialWrite | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [serverProblems, setServerProblems] = useState<readonly FieldProblem[]>([]);
  /** The confirmation was dismissed or refused, and focus is owed to the button it replaced. */
  const [backToSubmit, setBackToSubmit] = useState(false);

  // Under its set's own heading when it edits one, and under the card's when it writes a new
  // one, so the outline has no level missing either way.
  const Heading = set === null ? 'h3' : 'h4';
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (pending !== null) confirmation.current?.focus();
  }, [pending]);
  useEffect(() => {
    if (!backToSubmit || pending !== null) return;
    submit.current?.focus();
    setBackToSubmit(false);
  }, [backToSubmit, pending]);

  const problems = useMemo(() => allProblems(fields, values, readAt, fieldsOf), [fields, values]);
  const dirty = isDirty(values, set, schema);
  const changes = secretChangeSentence(secretChanges(schema, values, stored));

  const onReplace = useCallback((field: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  }, []);

  const refused = (error: unknown, fallback: string): void => {
    const failed = asApiError(error, fallback);
    setFailure(failed);
    setServerProblems(refusedFields(failed));
    // A save refused after it was confirmed takes the confirmation, and the button that had focus,
    // away: focus goes to the save button the confirmation stood in for.
    if (pending !== null) setBackToSubmit(true);
    setPending(null);
    setBusy(null);
  };

  const write = (): void => {
    setBusy('saving');
    send<CredentialWrite>('PUT', path, { values })
      .then((result) => {
        onSaved(savedSentence(kind.name, object.name, result, schema));
      })
      .catch((error: unknown) => {
        refused(error, 'the set could not be saved');
      });
  };

  const check = (): void => {
    setBusy('checking');
    setFailure(null);
    setServerProblems([]);
    send<CredentialWrite>('PUT', `${path}?dryRun=true`, { values })
      .then((preview) => {
        if (needsConfirmation(preview)) {
          setPending(preview);
          setBusy(null);
        } else {
          write();
        }
      })
      .catch((error: unknown) => {
        refused(error, 'the set could not be checked');
      });
  };

  const held = busy !== null || pending !== null;
  const withheld = pending === null ? null : boundsSentence(pending, object.name, 'will');
  const cleared =
    pending === null ? null : clearedSentence(secretLabels(schema, pending.secretsCleared), 'will');

  return (
    <form
      aria-labelledby={headingId}
      className="space-y-4 border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!held && dirty && problems.length === 0) check();
      }}
    >
      <div>
        <Heading
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="text-sm font-medium text-text"
        >
          {set === null ? `New ${kind.name} credentials` : `Editing ${kind.name} credentials`}
        </Heading>
        <p className="mt-1 text-xs text-text-muted">{kind.description}</p>
      </div>

      <SchemaForm
        schema={schema}
        values={values}
        redacted={stored}
        onChange={setValues}
        replacing={replacing}
        onReplace={onReplace}
        disabled={held}
        serverProblems={serverProblems}
      />

      {changes !== null && <p className="text-xs text-text-muted">{changes}</p>}

      {/* The confirmation or the buttons, with the refusal above them, as one block: the refusal
          is always there, and as a child of the form's stack it would add the stack's margin
          while it says nothing (`U-52`). The refusal and the confirmation are never both up: a
          refusal takes the confirmation away, and a check empties the refusal as it starts. */}
      <div>
        <Refusal error={failure} className="mb-4 empty:mb-0" />
        {pending !== null && (
          <div
            ref={confirmation}
            tabIndex={-1}
            role="group"
            aria-label="Confirm this save"
            className="space-y-2 border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg"
          >
            <p className="font-medium">Before this is saved</p>
            {withheld !== null && <p>{withheld}</p>}
            {pending.withholds > 0 && <p>{OUTSIDE_MEANS}</p>}
            {cleared !== null && <p>{cleared}</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={write}
                className="border border-warning-fg px-2 py-1 text-sm text-warning-fg hover:bg-surface disabled:opacity-50"
              >
                {busy === 'saving' ? 'Saving…' : 'Save anyway'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setPending(null);
                  setBackToSubmit(true);
                }}
                className={BUTTON}
              >
                Go back
              </button>
            </div>
          </div>
        )}

        {pending === null && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              ref={submit}
              type="submit"
              disabled={held || !dirty || problems.length > 0}
              className={PRIMARY}
            >
              {busy === 'checking'
                ? 'Checking…'
                : busy === 'saving'
                  ? 'Saving…'
                  : set === null
                    ? `Store ${kind.name} credentials`
                    : 'Save changes'}
            </button>
            <button type="button" disabled={busy !== null} onClick={onCancel} className={BUTTON}>
              Cancel
            </button>
            {problems.length > 0 && (
              <span className="text-xs text-text-muted">
                {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
              </span>
            )}
            {problems.length === 0 && !dirty && (
              <span className="text-xs text-text-muted">Nothing has changed yet.</span>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
