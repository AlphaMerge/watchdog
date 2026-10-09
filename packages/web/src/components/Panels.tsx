import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from '../api/client';
import { keepFocusOnThePage } from './keep-focus';

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
 * The one span every refusal line uses (`U-65`), inside the refusal's own region so it is said
 * with the message. Its text starts with a space: a margin separates the two on screen but not in
 * the text a screen reader reads, where the id would run into the message's last word. A refusal
 * the page decided itself has no id, and gets nothing. `size` is for a line whose id is set
 * smaller than its message (`CredentialsPanel`'s `text-xs` under `text-sm`).
 */
export function CorrelationId({
  id,
  size,
}: {
  id: string | undefined;
  size?: 'text-xs';
}): React.JSX.Element | null {
  if (id === undefined) return null;
  return (
    <span className={size === undefined ? 'ml-2 font-mono' : `ml-2 font-mono ${size}`}> {id}</span>
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
 *
 * **Pressing *Try again* never drops focus to the page** (`U-68`, WCAG 2.4.3). Two parts, because
 * a retry can end two ways:
 * - **While it re-reads, and when it fails again, the panel stays.** A caller that gives it a
 *   retry which keeps the failure in hand (`useApi`'s `retry`, or a hook that holds its error the
 *   same way) leaves the panel mounted, so the button that has focus is the one still there. It
 *   says *Trying again…*, `aria-disabled` rather than `disabled` (which would drop the focus it
 *   holds), and a press then asks nothing. The message is taken out of the region while it waits
 *   and put back with the next failure, so a failure in the same words is said again, as `U-63`'s
 *   *Try again* does. Busy is "pressed for the error shown": every read that fails parses a new
 *   one, so the next failure ends it without the caller saying so.
 * - **When the panel goes, focus goes to the page's heading** (`keep-focus.ts`). A read that
 *   succeeds takes the panel away with it, and a caller whose retry goes back to a loading line
 *   takes it at once. Either way, if focus was in the panel, it is put on the page's `h1`
 *   (`PageTitle`'s, which is focusable for exactly this and is where focus goes on arriving at a
 *   page, `U-11`): it is the one target every page has that outlives every state of its reads,
 *   and the panel cannot know which of the caller's controls will be there. A page that is only
 *   the panel until its read succeeds has no heading yet, and its heading takes focus as it is
 *   put on the page. A caller that moves focus somewhere nearer in its own effect wins, since
 *   that runs after.
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
  const panel = useRef<HTMLDivElement>(null);
  const [pressedFor, setPressedFor] = useState<ApiError | null>(null);
  const busy = retry !== undefined && pressedFor === error;

  useLayoutEffect(() => {
    const node = panel.current;
    return () => {
      if (node !== null && node.contains(document.activeElement)) keepFocusOnThePage(node);
    };
  }, []);

  const unreachable = error.code === 'UNREACHABLE';
  return (
    <div
      ref={panel}
      role={inRegion ? undefined : 'alert'}
      className="border border-down-border bg-down-bg p-4 text-sm text-down-fg"
    >
      {!busy && (
        <>
          <p className="ms-label text-down-fg">
            {unreachable ? 'The core is not reachable' : `Request failed — ${error.code}`}
          </p>
          <p className="mt-1.5">{error.message}</p>
          {unreachable && (
            <p className="mt-2">
              Start it with{' '}
              <code className="font-mono">
                scripts/dev.sh &quot;node packages/core/dist/src/main.js --config
                dev/core.json&quot;
              </code>
              .
            </p>
          )}
          {error.correlationId !== undefined && (
            <p className="mt-2 font-mono text-xs">correlation {error.correlationId}</p>
          )}
        </>
      )}
      {retry !== undefined && (
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            setPressedFor(error);
            retry();
          }}
          className={`ms-label border border-down-fg px-2 py-1 text-down-fg hover:bg-surface aria-disabled:opacity-60 ${busy ? '' : 'mt-3'}`}
        >
          {busy ? 'Trying again…' : 'Try again'}
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
