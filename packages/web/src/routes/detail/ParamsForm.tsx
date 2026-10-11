import { useCallback, useMemo, useState } from 'react';
import { ApiError, problemPath, send } from '../../api/client';
import type { ObjectDetail, SensorTypeSummary } from '../../api/types';
import { CorrelationId } from '../../components/Panels';
import { MappingPreview } from '../../forms/MappingPreview';
import { SchemaForm } from '../../forms/SchemaForm';
import { fieldsOf, readAt, type JsonSchema } from '../../forms/schema';
import { allProblems, type FieldProblem } from '../../forms/validate';
import { modeChangesOf, type ModeChange } from './model';

/**
 * A sensor's parameters, edited through the form its type's schema generates (`U-08`).
 *
 * **Saving sends only the parameters, and only ever the ones it can see.** A write-only
 * parameter the operator did not touch is absent from the patch and the core carries the stored
 * value forward — the mirror of redaction, and the reason a generated form can exist at all
 * without deleting every credential on its first save.
 *
 * The form validates against the schema for immediate feedback, but the core is the validator:
 * it runs the same schema through Ajv and its refusal names the path, which is shown against the
 * field it names.
 */
export function ParamsForm({
  detail,
  type,
  onSaved,
}: {
  detail: ObjectDetail;
  /** Absent when the catalogue does not know this sensor's type. */
  type: SensorTypeSummary | undefined;
  onSaved: () => void;
}): React.JSX.Element {
  const stored = useMemo(() => detail.params ?? {}, [detail.params]);
  const redacted = useMemo(() => detail.redactedParams ?? [], [detail.redactedParams]);

  const [values, setValues] = useState<Record<string, unknown>>(stored);
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [serverProblems, setServerProblems] = useState<readonly FieldProblem[]>([]);
  const [saved, setSaved] = useState(false);
  /** What the last accepted save's reply said it left alone (`U-36`). */
  const [lookupsKept, setLookupsKept] = useState<readonly string[]>([]);

  // **A saved edit is a new version of the sensor, and the form starts again from it.** The page
  // keeps this form mounted through the re-read a save asks for (`U-36`), so what was typed has
  // to be put back to what the core now holds — a value the core normalised, a secret now
  // stored — or the form would call itself changed the moment it was saved. Set while rendering,
  // as React's guide has a prop-derived reset done, so no render shows the stale values.
  const [basis, setBasis] = useState(detail.version);
  if (basis !== detail.version) {
    setBasis(detail.version);
    setValues(stored);
    setReplacing(new Set());
  }

  // Memoised on the type rather than derived inline: a fresh `{}` every render would rebuild the
  // field models, and with them the identities the form's own memos hang off.
  const schema = useMemo(() => (type?.paramsSchema ?? {}) as JsonSchema, [type]);
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const problems = useMemo(() => allProblems(fields, values, readAt, fieldsOf), [fields, values]);
  const dirty = JSON.stringify(values) !== JSON.stringify(stored) || replacing.size > 0;

  const onReplace = useCallback((path: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  if (type === undefined) {
    return (
      <p className="text-sm text-text-muted">
        <code className="font-mono">{detail.sensorType}</code> is not a registered sensor type, so
        there is no schema to build a form from. The stored parameters are intact — registering the
        type makes them editable again.
      </p>
    );
  }

  const modeChanges = failed === null ? null : modeChangesOf(failed);

  const save = (): void => {
    setSaving(true);
    setFailed(null);
    setServerProblems([]);
    setSaved(false);
    setLookupsKept([]);

    // `If-Match` is required on PATCH, and it is required for a reason: two operators with this
    // form open is the realistic collision, and under last-write-wins the second save silently
    // reverts the first. The tag is the version this form was built from.
    send<ObjectDetail>(
      'PATCH',
      `/objects/${String(detail.id)}`,
      { kind: 'sensor', params: values },
      { 'if-match': `W/"${String(detail.version)}"` },
    )
      .then((reply) => {
        setReplacing(new Set());
        setLookupsKept(reply.lookupsKept ?? []);
        setSaved(true);
        onSaved();
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          setFailed(error);
          // The core names the path it refused. Putting the message on that field beats a banner
          // saying "params are not valid" above twelve inputs.
          const named = (error.details.problems ?? [])
            .map((problem) => ({
              path: problemPath(problem),
              message: problem.message ?? 'was refused',
            }))
            .filter((problem) => problem.path !== '');
          setServerProblems(named);
        } else {
          setFailed(new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'));
        }
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <SchemaForm
        schema={schema}
        values={values}
        redacted={redacted}
        onChange={(next) => {
          setValues(next);
          setSaved(false);
        }}
        replacing={replacing}
        onReplace={onReplace}
        disabled={saving}
        serverProblems={serverProblems}
        existing={stored}
      />

      {type.hasPreview && <MappingPreview typeId={type.id} params={values} />}

      {/* The buttons and the refusal under them are one block, the form's last child: the refusal
          is always there, and `space-y-4` gives every child but the last a margin, so as a child
          of its own it would put that margin under the buttons while it says nothing (`U-52`). */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving || !dirty || problems.length > 0}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save parameters'}
          </button>
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => {
              setValues(stored);
              setReplacing(new Set());
              setServerProblems([]);
              setFailed(null);
            }}
            className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
          >
            Discard changes
          </button>
          {problems.length > 0 && (
            <span className="text-xs text-text-muted">
              {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
            </span>
          )}
        </div>

        {/* **An accepted save, in a region always there and empty until one** (`U-36`), for the
          reason the refusal's is (`U-41`): the line used to be added with its text in it, which is
          not reliably said. Polite, since nothing went wrong; said whole, by the status role's own
          atomicity. Emptied by the next save and by any change. */}
        <div role="status" className="mt-2 text-xs empty:mt-0">
          {saved && !dirty && (
            <>
              <p className="text-up-fg">
                Saved. The probe picks the change up on its next configuration push.
              </p>
              {lookupsKept.length > 0 && <LookupsKept channels={lookupsKept} />}
            </>
          )}
        </div>

        {/* **A refused save, in a region always there and empty until a refusal** (`U-54`, as
          `U-48` and `U-52` did): focus is on Save when the core refuses, nothing moves it, and a
          region added with its text already in it is not reliably announced (`U-41`). One region
          for both shapes of refusal, so the one that comes is said whichever it is. `save` and
          *Discard changes* empty it, so a second refusal in the same words is a change again.
          No space while it says nothing (`empty:mt-0`, `U-45`). */}
        <div role="alert" className="mt-4 empty:mt-0">
          {failed !== null && modeChanges !== null && (
            <ModeRefusal error={failed} changes={modeChanges} />
          )}
          {failed !== null && modeChanges === null && (
            <p className="text-xs text-down-fg">
              {failed.message}
              {failed.status === 412 &&
                ' — somebody else changed this sensor since this form was opened. Reload to see' +
                  ' their change before saving over it.'}
              <CorrelationId id={failed.correlationId} />
            </p>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * The edit was saved, but a lookup it declares was not applied (`U-36`, `P-311`).
 *
 * The sensor's type cannot say what its stored parameters declared — they were written by an
 * older build, say — so a lookup set by hand on the channel cannot be told from the one the type
 * set, and the core leaves the lookup as it is rather than overwrite an operator's choice. Said
 * after *Saved*, in text and not by colour alone, naming each channel, with the way forward: the
 * operator who made the edit is the one who knows whether the kept lookup is still right. No form
 * here sets a channel's lookup, so it says where one is set.
 */
function LookupsKept({ channels }: { channels: readonly string[] }): React.JSX.Element {
  const one = channels.length === 1;
  return (
    <div className="mt-1 text-text">
      <p>
        {one
          ? 'One channel kept its lookup'
          : `${String(channels.length)} channels kept their lookup`}
        : this sensor’s stored parameters can no longer be read by its type, so a lookup chosen by
        hand could not be told from the one the type set, and the edit left {one ? 'it' : 'them'} as{' '}
        {one ? 'it was' : 'they were'}. The Channels table shows the lookup{' '}
        {one ? 'it has' : 'each has'}; a channel’s lookup is set through the API, at{' '}
        <code className="font-mono">
          PATCH /api/v1/objects/{'{id}'}/channels/{'{key}'}
        </code>
        .
      </p>
      <ul className="mt-1 list-disc pl-5">
        {channels.map((key) => (
          <li key={key}>
            Channel <code className="font-mono">{key}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The core refused an edit that would turn a channel from a counter into a gauge or back
 * (`P-303`, `U-34`).
 *
 * **Said in full, not as a line of small red text under the buttons.** The refusal is not a typo
 * to correct: the edit cannot be made to this sensor at all, and the way forward is a different
 * action — put the value back, or add a new sensor. So it names each channel and direction, and
 * keeps the core's own sentence, which says why. Said by the form's refusal region, which is an
 * alert because it appears after a submit, away from where focus is, and nothing else would tell a
 * screen reader the save did not happen; not an alert of its own, since it is added with its text
 * and would not be reliably announced (`U-54`).
 */
function ModeRefusal({
  error,
  changes,
}: {
  error: ApiError;
  changes: readonly ModeChange[];
}): React.JSX.Element {
  return (
    <div className="space-y-2 border border-down-border bg-down-bg p-3 text-sm">
      <p className="font-medium text-down-fg">
        Not saved: this edit would change what{' '}
        {changes.length > 1 ? 'these channels store' : 'a channel stores'}.
      </p>
      {changes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-text">
          {changes.map((change) => (
            <li key={change.key}>
              Channel <code className="font-mono">{change.key}</code>: a {change.from} cannot become
              a {change.to}.
            </li>
          ))}
        </ul>
      )}
      {/* The id after the core's sentence and a space, in `CorrelationId` as every other refusal
          line has it (`U-65`, `U-70`): in a paragraph of its own it was said as a line by itself. */}
      <p className="text-text">
        {error.message}
        <CorrelationId id={error.correlationId} size="text-xs" />
      </p>
    </div>
  );
}
