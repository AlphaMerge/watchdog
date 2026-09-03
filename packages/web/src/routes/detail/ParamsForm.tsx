import { useCallback, useMemo, useState } from 'react';
import { ApiError, problemPath, send } from '../../api/client';
import type { ObjectDetail, SensorTypeSummary } from '../../api/types';
import { MappingPreview } from '../../forms/MappingPreview';
import { SchemaForm } from '../../forms/SchemaForm';
import { fieldsOf, readAt, type JsonSchema } from '../../forms/schema';
import { allProblems, type FieldProblem } from '../../forms/validate';

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

  const save = (): void => {
    setSaving(true);
    setFailed(null);
    setServerProblems([]);
    setSaved(false);

    // `If-Match` is required on PATCH, and it is required for a reason: two operators with this
    // form open is the realistic collision, and under last-write-wins the second save silently
    // reverts the first. The tag is the version this form was built from.
    send<ObjectDetail>(
      'PATCH',
      `/objects/${String(detail.id)}`,
      { kind: 'sensor', params: values },
      { 'if-match': `W/"${String(detail.version)}"` },
    )
      .then(() => {
        setReplacing(new Set());
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
      />

      {type.hasPreview && <MappingPreview typeId={type.id} params={values} />}

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
        {saved && !dirty && (
          <span className="text-xs text-up-fg" role="status">
            Saved. The probe picks the change up on its next configuration push.
          </span>
        )}
      </div>

      {failed !== null && (
        <p className="text-xs text-down-fg">
          {failed.message}
          {failed.status === 412 &&
            ' — somebody else changed this sensor since this form was opened. Reload to see' +
              ' their change before saving over it.'}
          {failed.correlationId !== undefined && (
            <span className="ml-2 font-mono"> {failed.correlationId}</span>
          )}
        </p>
      )}
    </form>
  );
}
