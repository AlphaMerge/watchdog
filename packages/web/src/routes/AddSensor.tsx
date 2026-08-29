import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, problemPath, send, useApi } from '../api/client';
import type { ObjectDetail, SensorTypeSummary } from '../api/types';
import { Card, ErrorPanel, Loading } from '../components/Panels';
import { SchemaForm } from '../forms/SchemaForm';
import { fieldsOf, readAt, seedDefaults, type JsonSchema } from '../forms/schema';
import { allProblems, type FieldProblem } from '../forms/validate';
import { PageTitle } from '../components/PageTitle';

/**
 * Adding a sensor (`U-08`).
 *
 * **The whole form after "which type" is generated**, which is what `P-05` published the
 * catalogue's schemas for: a new sensor type is a one-file job, and it would stop being one the
 * moment somebody had to hand-write an add form to go with it.
 *
 * **Defaults are pre-filled here and not on the edit form**, and the difference is deliberate.
 * The core applies and *stores* schema defaults at validation time, so a new sensor really will
 * have them — showing them is showing what is about to happen. On an existing sensor the same
 * pre-fill would be a lie: a parameter absent from the stored row is absent, and drawing the
 * default into the box would tell an operator a value is set when it is not.
 */
export function AddSensor(): React.JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const parent = useApi<ObjectDetail>(`/objects/${id}`);
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');

  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<ApiError | null>(null);
  const [serverProblems, setServerProblems] = useState<readonly FieldProblem[]>([]);

  const chosen =
    types.status === 'ready' ? types.data.items.find((t) => t.id === typeId) : undefined;
  const schema = useMemo(() => (chosen?.paramsSchema ?? {}) as JsonSchema, [chosen]);
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  const problems = useMemo(() => allProblems(fields, values, readAt, fieldsOf), [fields, values]);

  /** Picking a type replaces the parameters entirely — they belong to the type, not the form. */
  const pickType = useCallback(
    (next: string) => {
      setTypeId(next);
      setServerProblems([]);
      const type =
        types.status === 'ready' ? types.data.items.find((t) => t.id === next) : undefined;
      setValues(seedDefaults(type?.paramsSchema ?? {}));
      setReplacing(new Set());
    },
    [types],
  );

  const onReplace = useCallback((path: string, on: boolean) => {
    setReplacing((held) => {
      const next = new Set(held);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  if (parent.status === 'loading' || types.status === 'loading') return <Loading what="the form" />;
  if (parent.status === 'error') return <ErrorPanel error={parent.error} retry={parent.reload} />;
  if (types.status === 'error') return <ErrorPanel error={types.error} retry={types.reload} />;

  const catalogue = types.data.items;
  const ready = name.trim() !== '' && typeId !== '' && problems.length === 0;

  const create = (): void => {
    setSaving(true);
    setFailed(null);
    setServerProblems([]);

    send<ObjectDetail>('POST', '/objects', {
      kind: 'sensor',
      parentId: parent.data.id,
      name: name.trim(),
      sensorType: typeId,
      params: values,
    })
      .then((created) => {
        void navigate(`/objects/${String(created.id)}`);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError) {
          setFailed(error);
          setServerProblems(
            (error.details.problems ?? [])
              .map((problem) => ({
                path: problemPath(problem),
                message: problem.message ?? 'was refused',
              }))
              .filter((problem) => problem.path !== ''),
          );
        } else {
          setFailed(new ApiError(0, 'UNKNOWN', error instanceof Error ? error.message : 'failed'));
        }
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="space-y-4">
      <PageTitle title={`Add a sensor to ${parent.data.name}`}>
        Add a sensor to <span className="font-normal text-text-muted">{parent.data.name}</span>
      </PageTitle>

      <Card>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) create();
          }}
        >
          <div className="space-y-1">
            <label htmlFor="sensor-name" className="text-sm font-medium text-text">
              Name
            </label>
            <input
              id="sensor-name"
              value={name}
              disabled={saving}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className="w-full max-w-md rounded border border-control bg-surface px-2 py-1 text-sm text-text"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="sensor-type" className="text-sm font-medium text-text">
              Sensor type
            </label>
            <select
              id="sensor-type"
              value={typeId}
              disabled={saving}
              onChange={(event) => {
                pickType(event.target.value);
              }}
              className="w-full max-w-md rounded border border-control bg-surface px-2 py-1 text-sm text-text"
            >
              <option value="">Choose a type…</option>
              {catalogue.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.id} — {type.category}
                </option>
              ))}
            </select>
            {catalogue.length === 0 && (
              // The core refuses to create any sensor with an empty catalogue and says so at
              // boot; a form that offered an empty select would let somebody find that out the
              // hard way.
              <p className="text-xs text-warning-fg">
                No sensor types are registered, so no sensor can be created. The core logs this at
                startup.
              </p>
            )}
          </div>

          {chosen !== undefined && (
            <fieldset className="space-y-4 border-t border-border pt-4">
              <legend className="sr-only">Parameters for {chosen.id}</legend>
              <SchemaForm
                schema={schema}
                values={values}
                redacted={[]}
                onChange={setValues}
                replacing={replacing}
                onReplace={onReplace}
                disabled={saving}
                serverProblems={serverProblems}
              />
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving || !ready}
              className="rounded border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create sensor'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                void navigate(`/objects/${String(parent.data.id)}`);
              }}
              className="rounded border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            {problems.length > 0 && (
              <span className="text-xs text-text-muted">
                {problems.length} {problems.length === 1 ? 'field needs' : 'fields need'} attention
              </span>
            )}
          </div>

          {failed !== null && (
            <p className="text-xs text-down-fg">
              {failed.message}
              {failed.correlationId !== undefined && (
                <span className="ml-2 font-mono opacity-75"> {failed.correlationId}</span>
              )}
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}
