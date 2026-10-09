import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, send, useApi } from '../api/client';
import type { ReportKind, ReportSummary } from '../api/types';
import { Card, Empty, ErrorPanel, Loading, RefusalPanel } from '../components/Panels';
import { PageTitle } from '../components/PageTitle';
import { REPORT_KINDS, labelOfKind, nextRunText, whyItCannotRun } from './reports-model';
import { listedName, sharedNames } from './names';

/**
 * The reports this account may see, and the button that makes another (`E-11`).
 *
 * **Everything here comes back from `GET /reports`, which is already filtered.** An administrator
 * sees every report and everybody else sees the ones a group they belong to was granted, so this
 * page never decides who may look at what — `ReportService` does, and a second copy of that rule
 * here would eventually disagree with it. The same reasoning `MapsView` records.
 *
 * **What is not hidden is anything behind write access.** Creating and running are refused by the
 * core with a message, and showing a button that explains why beats hiding one whose absence is a
 * support conversation — which is the rule `Layout` states about showing the role beside the name.
 */
export function ReportsView(): React.JSX.Element {
  const reports = useApi<{ items: ReportSummary[] }>('/reports');
  const shared = sharedNames(reports.status === 'ready' ? reports.data.items : []);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ReportKind>('table_only');
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const navigate = useNavigate();

  const create = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    if (name.trim() === '' || creating) return;
    setCreating(true);
    setFailure(null);
    send<ReportSummary>('POST', '/reports', { name: name.trim(), kind })
      .then((made) => {
        // Straight into the report: a new one covers nothing and runs manually, and a list entry
        // for it is not what anybody was after.
        void navigate(`/reports/${String(made.id)}`);
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable'),
        );
        setCreating(false);
      });
  };

  return (
    <div className="space-y-4">
      <PageTitle title="Reports" />

      <Card title="New report">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={100}
              className="mt-1 w-64 max-w-full border border-control bg-surface px-2 py-1 text-sm text-text"
            />
          </label>
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Template</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ReportKind);
              }}
              className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
            >
              {REPORT_KINDS.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={name.trim() === '' || creating}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </form>
        {/*
          Said beside the chooser rather than discovered by scheduling one. Only two templates
          render today; the rest are gated on an ADR or unwritten, and a form that offered all
          seven as equals would let somebody schedule a monthly report that produces nothing.
        */}
        <p className="mt-2 text-xs text-text-muted">
          {REPORT_KINDS.find((one) => one.id === kind)?.note}
        </p>
        <p className="mt-1 text-xs text-text-muted">
          A new report covers nothing, runs only when somebody asks, and renders as you.
        </p>
        {/* A refused create, in a region always there and empty until one (`U-54`). */}
        <RefusalPanel error={failure} className="mt-3 empty:mt-0" />
      </Card>

      <Card title="Reports">
        {reports.status === 'loading' && <Loading what="reports" />}
        {reports.status === 'error' && <ErrorPanel error={reports.error} retry={reports.retry} />}
        {reports.status === 'ready' && reports.data.items.length === 0 && (
          <Empty because="A report is a saved question about a period — make one above.">
            No reports yet.
          </Empty>
        )}
        {reports.status === 'ready' && reports.data.items.length > 0 && (
          <ul className="divide-y divide-border">
            {reports.data.items.map((report) => {
              const problem = whyItCannotRun(report);
              return (
                <li key={report.id} className="py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      to={`/reports/${String(report.id)}`}
                      className="text-sm text-text underline"
                    >
                      {listedName(report, shared)}
                    </Link>
                    <span className="ms-label text-text-muted">{labelOfKind(report.kind)}</span>
                  </div>
                  <p className="text-xs text-text-muted">
                    {report.scheduleSummary} · next: {nextRunText(report)}
                  </p>
                  {/*
                    A report that will not run says so in the list, not only on its own page. The
                    failure this prevents is an operator scanning twenty reports and seeing
                    nothing wrong with the one that has been silently refusing since August.
                  */}
                  {problem !== null && (
                    <p className="mt-1 border-l-2 border-warning-border pl-2 text-xs text-text-muted">
                      {problem}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
