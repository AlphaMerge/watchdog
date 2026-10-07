import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, problemPath, send, useApi } from '../api/client';
import { useProbeStream, useSettledReload } from '../api/stream';
import type { AncestorsView, ObjectDetail, ProbeHealthView, SensorTypeSummary } from '../api/types';
import { Card, ErrorPanel, Loading } from '../components/Panels';
import { MappingPreview } from '../forms/MappingPreview';
import { SchemaForm } from '../forms/SchemaForm';
import { fieldsOf, readAt, seedDefaults, type JsonSchema } from '../forms/schema';
import { allProblems, type FieldProblem } from '../forms/validate';
import { PageTitle } from '../components/PageTitle';
import {
  listenerNotice,
  probeAbove,
  readsListener,
  refusesProbe,
  type HealthAnswer,
  type ListenerNotice,
} from './add-sensor-model';

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

  // **Whether the probe this sensor would run on has the listener the type reads** (`B-08`).
  // Asked only for a type that reads one, so the form for every other type makes no request it
  // did not make before; and asked of routes that answer under the probe's own `read` right, so
  // an account that cannot see the probe is told nothing — both requests simply do not answer.
  const asksListener = readsListener(chosen?.listener);
  const above = useApi<AncestorsView>(
    asksListener && parent.status === 'ready' && parent.data.kind !== 'probe'
      ? `/objects/${id}/ancestors`
      : null,
  );
  const probe =
    asksListener && parent.status === 'ready'
      ? probeAbove(parent.data, above.status === 'ready' ? above.data.items : [])
      : null;
  const probeHealth = useApi<ProbeHealthView>(
    probe === null ? null : `/probes/${String(probe.id)}/health`,
  );
  // **The answer is asked again when the stream says the probe changed** (`B-12`, `U-24`,
  // `ProbeWatch` below), and the last one stands while the next is on its way. Without that,
  // every re-ask would empty the notice and write the same sentence back, and a live region
  // announces what is written into it: one sentence read out again for every time the probe's
  // link moved. A refusal is not held over — a reader who may no longer see the probe is
  // told nothing about it, as before.
  //
  // **A request that failed for any other reason is said, not held** (`U-29` review). A 503 from
  // a core that is starting, any other 5xx and a network failure all used to read as silence,
  // which means "running": an "off" caution vanished for the length of a core restart. Holding
  // the last answer through the failure instead was the other way to fix that. It was not taken,
  // for two reasons. It would show an old reading as current for as long as the core stays away.
  // And a first request that fails has no answer to hold, so silence would still mean
  // "running". So the form says it could not ask, and that sentence is held while the next
  // request is on its way, like any other.
  const probeId = probe?.id ?? null;
  const answered: HealthAnswer | undefined =
    probeHealth.status === 'ready'
      ? probeHealth.data
      : probeHealth.status === 'error'
        ? refusesProbe(probeHealth.error.status)
          ? null
          : 'unanswered'
        : undefined;
  const held = useRef<{ probeId: number; answer: HealthAnswer } | null>(null);
  useEffect(() => {
    if (probeId === null || answered === undefined) return;
    held.current = answered === null ? null : { probeId, answer: answered };
  }, [probeId, answered]);
  const last = held.current;
  const health: HealthAnswer =
    answered !== undefined
      ? answered
      : last !== null && last.probeId === probeId
        ? last.answer
        : null;
  const listenerSays = probe === null ? null : listenerNotice(chosen?.listener, probe.name, health);

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
              className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
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
              aria-describedby={listenerSays === null ? undefined : 'sensor-type-listener'}
              onChange={(event) => {
                pickType(event.target.value);
              }}
              className="w-full max-w-md border border-control bg-surface px-2 py-1 text-sm text-text"
            >
              <option value="">Choose a type…</option>
              {catalogue.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.id} — {type.category}
                </option>
              ))}
            </select>
            {/* Always in the document, so that what appears in it is announced: a live region
                added together with its text is one a screen reader may never have been watching.
                The sentence is the notice; the colour only matches the form's other cautions, and
                "cannot tell" (`U-29`) is plain text because it is not one. */}
            <p
              id="sensor-type-listener"
              role="status"
              className={
                listenerSays === null
                  ? 'sr-only'
                  : listenerSays.kind === 'off'
                    ? 'max-w-2xl text-xs text-warning-fg'
                    : 'max-w-2xl text-xs text-text-muted'
              }
            >
              {listenerSays !== null && <NoticeText notice={listenerSays} />}
            </p>
            {probe !== null && <ProbeWatch probeId={probe.id} onNews={probeHealth.reload} />}
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
              {chosen.hasPreview && <MappingPreview typeId={chosen.id} params={values} />}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving || !ready}
              className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create sensor'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                void navigate(`/objects/${String(parent.data.id)}`);
              }}
              className="border border-control px-3 py-1 text-sm text-text-muted hover:text-text disabled:opacity-50"
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
                <span className="ml-2 font-mono"> {failed.correlationId}</span>
              )}
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}

/**
 * A notice's sentence, with the time it names marked up as one (`U-32`), as the rest of the UI
 * marks a time: `<time>` with the instant in `dateTime` and `title`. What is read is the sentence,
 * which says the time in words and in full, so nothing is only in the tooltip.
 */
function NoticeText({ notice }: { notice: ListenerNotice }): React.JSX.Element {
  const time = notice.time;
  const at = time === undefined ? -1 : notice.text.indexOf(time.shown);
  if (time === undefined || at < 0) return <>{notice.text}</>;
  return (
    <>
      {notice.text.slice(0, at)}
      <time dateTime={time.dateTime} title={time.dateTime}>
        {time.shown}
      </time>
      {notice.text.slice(at + time.shown.length)}
    </>
  );
}

/**
 * Asks about the probe again when the core says the probe itself changed (`B-12`, `U-24`).
 *
 * The notice was read once, when the type was chosen, and a form is open for as long as somebody
 * takes to fill it in: a probe restarted with its collector on left "is not running" standing,
 * and a probe that dropped left a sentence about a setting nobody could any longer vouch for.
 *
 * **The stream is the prompt and `GET /probes/{id}/health` is still the answer.** The frame says
 * that the probe connected, dropped, or sent a report in which a listener came or went, and
 * carries nothing else — so it means only "ask again", after the settle the alarms list uses, and
 * a link that flaps is one request once it stops.
 *
 * **A watch on the probe, not a subscription to its branch** (`U-24`). `B-12` could only listen
 * for a sensor under the probe changing state, which said nothing for a probe with no sensor the
 * reader can see — exactly a probe getting its first — and which could prompt the form before a
 * reconnected probe's first report with nothing to prompt it again when the report arrived. It
 * also took a snapshot of every sensor on the probe for the sake of one sentence.
 *
 * **A component, so that it is a socket only while there is a probe to watch.** A hook cannot be
 * called conditionally: the form for a type that reads no listener, or for a reader who cannot
 * see the probe, opens nothing — as it made no request before. Choosing another type unmounts
 * this and closes the socket.
 *
 * Renders nothing. What changes on the page is the notice's text, in the region that was already
 * announcing it; focus is never moved.
 *
 * **The watch standing is news, once** (`U-26`). The form asked the probe's health when the type
 * was chosen, and the watch stands a moment later; a probe that connected, dropped or reported
 * in between was heard by neither. So the form asks again when the core says the watch stands:
 * one more request each time the form opens a watch. The answer is nearly always the one it
 * has, and then nothing is written into the notice and nothing is announced (`B-12`): the last
 * answer stands while the next is on its way, and the same sentence is the same text node.
 */
function ProbeWatch({
  probeId,
  onNews,
}: {
  readonly probeId: number;
  readonly onNews: () => void;
}): null {
  const live = useProbeStream(probeId);
  useSettledReload(live, onNews, 'news');
  return null;
}
