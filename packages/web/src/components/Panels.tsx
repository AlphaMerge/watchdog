import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-surface">
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-text">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Loading({ what }: { what: string }): React.JSX.Element {
  return (
    <p className="text-sm text-text-muted" role="status">
      Loading {what}…
    </p>
  );
}

/**
 * An error the operator can act on.
 *
 * The correlation id is shown because the core logs it against every request: it is the one
 * string that turns "it broke" into a line in the journal.
 */
export function ErrorPanel({
  error,
  retry,
}: {
  error: ApiError;
  retry?: () => void;
}): React.JSX.Element {
  const unreachable = error.code === 'UNREACHABLE';
  return (
    <div
      role="alert"
      className="rounded-lg border border-down-border bg-down-bg p-4 text-sm text-down-fg"
    >
      <p className="font-semibold">
        {unreachable ? 'The core is not reachable' : `Request failed — ${error.code}`}
      </p>
      <p className="mt-1">{error.message}</p>
      {unreachable && (
        <p className="mt-2 opacity-90">
          Start it with{' '}
          <code className="font-mono">
            scripts/dev.sh &quot;node packages/core/dist/src/main.js --config dev/core.json&quot;
          </code>
          .
        </p>
      )}
      {error.correlationId !== undefined && (
        <p className="mt-2 font-mono text-xs opacity-80">correlation {error.correlationId}</p>
      )}
      {retry !== undefined && (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded border border-down-fg px-2 py-1 font-medium hover:bg-surface"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Nothing here — and, when we know it, *why* nothing is here.
 *
 * "No data" on its own invites the reader to assume a bug. Naming the task that produces the
 * data turns an empty panel into a status report, which is what it actually is at this stage of
 * the project.
 */
export function Empty({
  children,
  because,
}: {
  children: ReactNode;
  because?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm text-text-muted">{children}</p>
      {because !== undefined && (
        <p className="mt-1 text-xs text-text-muted opacity-80">{because}</p>
      )}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-text-muted">{hint}</div>}
    </div>
  );
}
