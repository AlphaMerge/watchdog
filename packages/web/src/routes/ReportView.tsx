import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, send, useApi } from '../api/client';
import type { ReportRun, ReportSubjects, ReportSummary } from '../api/types';
import { Card, ErrorPanel, Loading, RefusalPanel } from '../components/Panels';
import { PageTitle } from '../components/PageTitle';
import { ReportSettings } from '../reports/ReportSettings';
import {
  deliveryText,
  downloadPath,
  durationText,
  labelOfKind,
  nextRunText,
  runSummary,
  sizeText,
  whyItCannotRun,
} from './reports-model';

/**
 * One report: what it covers, when it runs, and what it has produced (`E-11`).
 *
 * **The reading half and the editing half on one page, in that order**, which is where this
 * differs from `/maps/:id` and its separate designer. A map's editing surface is a canvas that
 * needs the whole viewport; a report's is eight fields, and splitting them across two routes
 * would mean an operator checking why last night failed has to navigate away to fix it.
 *
 * Nothing here decides whether the caller may write. The core refuses with a message and the
 * message is shown — the same choice `MapView` makes about its Edit link, and for the same
 * reason: a button that explains why beats one whose absence is a support conversation.
 */
export function ReportView(): React.JSX.Element {
  const { id } = useParams();
  const report = useApi<ReportSummary>(id === undefined ? null : `/reports/${id}`);
  const runs = useApi<{ items: ReportRun[] }>(id === undefined ? null : `/reports/${id}/runs`);
  const subjects = useApi<ReportSubjects>(id === undefined ? null : `/reports/${id}/subjects`);
  const [running, setRunning] = useState(false);
  const [runFailure, setRunFailure] = useState<ApiError | null>(null);

  const runNow = (): void => {
    if (id === undefined || running) return;
    setRunning(true);
    setRunFailure(null);
    send<ReportRun>('POST', `/reports/${id}/runs`, {})
      .then(() => {
        runs.reload();
        // The report's own row carries `lastRunAt`, so it is stale the moment a run finishes.
        report.reload();
      })
      .catch((error: unknown) => {
        setRunFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
      })
      .finally(() => {
        setRunning(false);
      });
  };

  const problem = report.status === 'ready' ? whyItCannotRun(report.data) : null;

  return (
    <div className="space-y-4">
      {/* The title row and a refused run under it are one block of the stack: the refusal is
          always there (`U-54`), and as a child of its own `space-y-4` would give it a margin
          while it says nothing. */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <PageTitle title={report.status === 'ready' ? report.data.name : 'Report'} />
          {report.status === 'ready' && (
            <button
              type="button"
              onClick={runNow}
              disabled={running}
              className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run now'}
            </button>
          )}
        </div>

        <RefusalPanel error={runFailure} className="mt-4 empty:mt-0" />
      </div>

      {report.status === 'loading' && <Loading what="the report" />}
      {report.status === 'error' && <ErrorPanel error={report.error} retry={report.retry} />}

      {report.status === 'ready' && (
        <>
          {/*
            Above everything, because a report that will not run makes every other panel on this
            page a description of something that is not happening.
          */}
          {problem !== null && (
            <div className="border-l-2 border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
              {problem}
            </div>
          )}

          <Card title="What it covers">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-text-muted">Template</dt>
              <dd>{labelOfKind(report.data.kind)}</dd>
              <dt className="text-text-muted">Period</dt>
              <dd>
                {report.data.resolved?.label ??
                  report.data.unresolvable?.message ??
                  'not resolvable'}
              </dd>
              {report.data.resolved !== undefined && (
                <>
                  <dt className="text-text-muted">Averaging</dt>
                  {/*
                    The bucket width *and* the tier that answers, because `§6`'s averaging rule is
                    not cosmetic — it decides which rollup serves the numbers, and an author who
                    pinned five minutes over a quarter has to learn it will be hourly here rather
                    than from a document a month later (`E-02`).
                  */}
                  <dd>
                    {String(report.data.resolved.bucketSeconds)} s, from{' '}
                    <span className="font-mono text-xs">{report.data.resolved.source}</span>
                  </dd>
                  {report.data.resolved.adjustments.length > 0 && (
                    <>
                      <dt className="text-text-muted">Adjusted</dt>
                      <dd>
                        <ul className="space-y-0.5">
                          {report.data.resolved.adjustments.map((one) => (
                            <li key={one.kind}>{one.reason}</li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  )}
                </>
              )}
              <dt className="text-text-muted">Renders as</dt>
              <dd>
                {report.data.runAs.login}
                {!report.data.runAs.available && ' — that account is gone'}
              </dd>
            </dl>

            <Subjects subjects={subjects} />
          </Card>

          <Card title="When it runs">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-text-muted">Schedule</dt>
              <dd>{report.data.scheduleSummary}</dd>
              <dt className="text-text-muted">Next</dt>
              <dd>{nextRunText(report.data)}</dd>
              <dt className="text-text-muted">Last</dt>
              <dd>{report.data.lastRunAt ?? 'never'}</dd>
            </dl>
          </Card>

          <Card title="Runs">
            {runs.status === 'loading' && <Loading what="runs" />}
            {runs.status === 'error' && <ErrorPanel error={runs.error} retry={runs.retry} />}
            {runs.status === 'ready' && runs.data.items.length === 0 && (
              <p className="text-sm text-text-muted">
                This report has not run yet. “Run now” renders it against the period above.
              </p>
            )}
            {runs.status === 'ready' && runs.data.items.length > 0 && (
              <ul className="divide-y divide-border">
                {runs.data.items.map((run) => (
                  <Run key={run.id} run={run} />
                ))}
              </ul>
            )}
          </Card>

          <ReportSettings
            report={report.data}
            onSaved={() => {
              report.reload();
              subjects.reload();
            }}
          />
        </>
      )}
    </div>
  );
}

/** One run, with whatever it produced. */
function Run({ run }: { run: ReportRun }): React.JSX.Element {
  const delivery = deliveryText(run);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-text">{runSummary(run)}</span>
        <span className="ms-label text-text-muted">
          {run.trigger === 'manual' ? `by ${run.requestedBy}` : 'scheduled'} ·{' '}
          {durationText(run.durationMs)}
        </span>
      </div>
      {delivery !== null && <p className="text-xs text-text-muted">{delivery}</p>}
      {run.outputs.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-3 text-xs">
          {run.outputs.map((file) => (
            /*
              A plain link rather than a fetch: the download route answers bytes with a
              `Content-Disposition`, and letting the browser do what it is for means the session
              cookie travels and a large report never passes through this app's memory.
            */
            <a
              key={file.format}
              href={downloadPath(run, file.format)}
              className="text-text underline"
            >
              {file.filename} ({sizeText(file.byteSize)})
            </a>
          ))}
        </p>
      )}
    </li>
  );
}

/**
 * What this report's security context can actually see (`E-03`).
 *
 * **Shown, rather than left for the output to reveal.** A report names object ids; whether its
 * account may read them is a separate question, and the answer can change under it when somebody
 * edits a grant. The unavailable ones are ids and nothing else — the core deliberately does not
 * say which are deleted and which are out of scope, because a `write` holder on a report needs no
 * access to the tree and the distinction would be an existence oracle.
 */
function Subjects({
  subjects,
}: {
  subjects: ReturnType<typeof useApi<ReportSubjects>>;
}): React.JSX.Element | null {
  if (subjects.status !== 'ready') return null;
  const { visible, unavailable } = subjects.data;
  if (visible.length === 0 && unavailable.length === 0) {
    return (
      <p className="mt-3 text-sm text-text-muted">
        This report covers nothing yet. Add object ids below.
      </p>
    );
  }
  return (
    <div className="mt-3 space-y-1 text-sm">
      <p className="text-text-muted">
        {String(visible.length)} object{visible.length === 1 ? '' : 's'} it can render
        {unavailable.length > 0 && `, ${String(unavailable.length)} it cannot`}
      </p>
      {visible.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-muted">
          {visible.map((one) => (
            <li key={one.id}>
              <span className="font-mono">{one.id}</span> {one.name}
            </li>
          ))}
        </ul>
      )}
      {unavailable.length > 0 && (
        <p className="text-xs text-text-muted">
          Not rendered: <span className="font-mono">{unavailable.join(', ')}</span> — deleted, or
          outside what this report’s account may read.
        </p>
      )}
    </div>
  );
}
