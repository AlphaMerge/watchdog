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
    <section className="border border-border bg-surface">
      {title !== undefined && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          {/* Uppercase and tracked, not bold: the rule under it is what separates the header
              from the body, so the type does not also have to shout. */}
          <h2 className="ms-label">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * A refused action, said through `ErrorPanel` in a region that is always there (`U-54`).
 *
 * **Empty until there is a refusal**, as `U-48` and `U-52` did for a line of text: focus is on
 * the control that was used when the core refuses, and a region added with its text already in it
 * is not reliably announced (`U-41`), which is what an `ErrorPanel` mounted on failure is. The
 * caller empties it as each attempt starts, so a second refusal in the same words is said again,
 * and gives its margin with an `empty:` twin, so it takes no space while it says nothing (`U-45`).
 * `children` follow the panel, and only while there is one.
 */
export function RefusalPanel({
  error,
  className,
  children,
}: {
  error: ApiError | null;
  className: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div role="alert" className={className}>
      {error !== null && <ErrorPanel error={error} inRegion />}
      {error !== null && children}
    </div>
  );
}

/**
 * The correlation id after a refusal's message, when the core sent one (`U-51`, `U-59`).
 *
 * The span `ParamsForm` and `SettingsPanel` use, inside the refusal's own region so it is said with
 * the message. Its text starts with a space: a margin separates the two on screen but not in the
 * text a screen reader reads, where the id would run into the message's last word. A refusal the
 * page decided itself has no id, and gets nothing.
 */
export function CorrelationId({ id }: { id: string | undefined }): React.JSX.Element | null {
  return id === undefined ? null : <span className="ml-2 font-mono"> {id}</span>;
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
  inRegion = false,
}: {
  error: ApiError;
  retry?: () => void;
  /** Shown inside a region that is already an alert (`RefusalPanel`), so not one of its own. */
  inRegion?: boolean;
}): React.JSX.Element {
  const unreachable = error.code === 'UNREACHABLE';
  return (
    <div
      role={inRegion ? undefined : 'alert'}
      className="border border-down-border bg-down-bg p-4 text-sm text-down-fg"
    >
      <p className="ms-label text-down-fg">
        {unreachable ? 'The core is not reachable' : `Request failed — ${error.code}`}
      </p>
      <p className="mt-1.5">{error.message}</p>
      {unreachable && (
        <p className="mt-2">
          Start it with{' '}
          <code className="font-mono">
            scripts/dev.sh &quot;node packages/core/dist/src/main.js --config dev/core.json&quot;
          </code>
          .
        </p>
      )}
      {error.correlationId !== undefined && (
        <p className="mt-2 font-mono text-xs">correlation {error.correlationId}</p>
      )}
      {retry !== undefined && (
        <button
          type="button"
          onClick={retry}
          className="ms-label mt-3 border border-down-fg px-2 py-1 text-down-fg hover:bg-surface"
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
    <div className="border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm text-text-muted">{children}</p>
      {because !== undefined && <p className="mt-1 text-xs text-text-muted">{because}</p>}
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
    <div className="border border-border bg-surface px-4 py-3">
      <div className="ms-label">{label}</div>
      {/* Regular weight. The size is the emphasis, and a system monospace has one bold worth
          having — spending it here leaves nothing for the places that are genuinely urgent. */}
      <div className="mt-1.5 text-2xl tabular-nums text-text">{value}</div>
      {hint !== undefined && <div className="mt-1 text-xs text-text-muted">{hint}</div>}
    </div>
  );
}
