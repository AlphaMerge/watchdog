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
import { Card, Empty, ErrorPanel, Loading } from '../../components/Panels';
import { SchemaForm } from '../../forms/SchemaForm';
import { fieldsOf, readAt } from '../../forms/schema';
import { allProblems, type FieldProblem } from '../../forms/validate';
import {
  UNBOUNDED_PATH,
  asksForRight,
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
  withholdsSentence,
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
  const [sets, reload] = useSets(`${base}/credentials`);
  const kinds = useApi<{ items: CredentialKindSummary[] }>('/credential-kinds');
  const access = useApi<EffectiveAccess>(asksForRight(session) ? `${base}/access/effective` : null);
  const canWrite = mayWrite(session, access);

  /** The kind whose form is open: an own set being edited, or a new one being written. */
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  /** What the last save or removal did, in the core's numbers. Announced, and left on screen. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);

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
  if (kinds.status === 'error') return <ErrorPanel error={kinds.error} retry={kinds.reload} />;

  const items = sets.data;
  const catalogue = kinds.data.items;
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
                busyElsewhere={editing !== null}
                onEdit={() => {
                  setNotice(null);
                  setEditing(set.kind);
                }}
                onCancel={() => {
                  setEditing(null);
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
                className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
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
              type="button"
              className={BUTTON}
              onClick={() => {
                setNotice(null);
                setEditing(chosen.id);
              }}
            >
              Add {chosen.name} credentials
            </button>
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
 */
function useSets(path: string): [Loadable<CredentialView[]>, () => void] {
  const [state, setState] = useState<Loadable<CredentialView[]>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request<{ items: CredentialView[] }>(path, controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data: answer.items });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: asApiError(error, 'the sets could not be read') });
      });
    return () => {
      controller.abort();
    };
  }, [path, nonce]);

  return [state, reload];
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
  onEdit,
  onRemoved,
}: {
  object: { id: number; name: string; kind: string };
  set: CredentialView;
  name: string;
  editable: boolean;
  ancestors: readonly ObjectRef[] | null;
  disabled: boolean;
  onEdit: () => void;
  onRemoved: (said: string) => void;
}): React.JSX.Element {
  const path = `/objects/${String(object.id)}/credentials/${set.kind}`;
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<CredentialRemoval | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (asked !== null) confirmation.current?.focus();
  }, [asked]);

  const ask = (): void => {
    setBusy(true);
    setFailure(null);
    send<CredentialRemoval>('DELETE', `${path}?dryRun=true`)
      .then(setAsked)
      .catch((error: unknown) => {
        setFailure(asApiError(error, 'the set could not be checked'));
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
        onRemoved(
          `Removed the ${name} set from ${object.name}. ` +
            removalSentence(name, object, outcome, ancestors, 'now'),
        );
      })
      .catch((error: unknown) => {
        setFailure(asApiError(error, 'the set could not be removed'));
        setAsked(null);
        setBusy(false);
      });
  };

  return (
    <div className="space-y-2">
      {asked === null ? (
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <button type="button" className={BUTTON} disabled={disabled || busy} onClick={onEdit}>
              Edit <span className="sr-only">{name} credentials</span>
            </button>
          )}
          <button type="button" className={BUTTON} disabled={disabled || busy} onClick={ask}>
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
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setAsked(null);
              }}
              className={BUTTON}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      {failure !== null && <Refusal error={failure} />}
    </div>
  );
}

function Refusal({ error }: { error: ApiError }): React.JSX.Element {
  return (
    <p role="alert" className="text-sm text-down-fg">
      {error.message}
      {error.correlationId !== undefined && (
        <span className="ml-2 font-mono text-xs">{error.correlationId}</span>
      )}
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
 * it keeps the set from any sensor, or clears a secret, the form stops and says so, and the
 * fields are held as they were previewed until the operator confirms or goes back.
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

  // Under its set's own heading when it edits one, and under the card's when it writes a new
  // one, so the outline has no level missing either way.
  const Heading = set === null ? 'h3' : 'h4';
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (pending !== null) confirmation.current?.focus();
  }, [pending]);

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
  const withheld =
    pending === null ? null : withholdsSentence(pending.withholds, object.name, 'will');
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
              }}
              className={BUTTON}
            >
              Go back
            </button>
          </div>
        </div>
      )}

      {failure !== null && <Refusal error={failure} />}

      {pending === null && (
        <div className="flex flex-wrap items-center gap-3">
          <button
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
    </form>
  );
}
