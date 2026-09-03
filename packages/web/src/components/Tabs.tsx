import { useCallback, useRef } from 'react';

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  /** Shown after the label — a count, usually. Absent when there is nothing to say. */
  readonly badge?: string;
}

export interface TabsProps {
  readonly tabs: readonly TabDefinition[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  readonly label: string;
}

/**
 * A tab strip that behaves the way the platform's tabs behave.
 *
 * **Arrow keys move between tabs, and only the active one is in the tab order.** That is the
 * ARIA authoring practice for a tablist and it is not a detail: with six tabs, a strip where
 * every tab takes a stop makes a keyboard user press Tab six times to reach the panel they are
 * looking at, on every page.
 *
 * Selecting is left to the caller, which puts it in the URL (`U-04`). A tab held in component
 * state cannot be linked to and does not survive a reload, and "look at the triggers on this
 * sensor" is exactly the kind of thing one person sends another.
 */
export function Tabs({ tabs, active, onSelect, label }: TabsProps): React.JSX.Element {
  const strip = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const next = nextTab(event.key, tabs, active);
      if (next === null) return;
      event.preventDefault();
      onSelect(next);
      strip.current?.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus();
    },
    [tabs, active, onSelect],
  );

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            className={`ms-label -mb-px border-b-2 px-3 py-2 ${
              selected ? 'border-accent text-text' : 'border-transparent hover:text-text'
            }`}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="ml-1.5 tabular-nums text-text-muted">{tab.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Which tab a key moves to, or null when the key is not ours.
 *
 * Wrapping is deliberate and it is what the authoring practice specifies: a tab strip is a ring,
 * and stopping dead at the last tab makes it feel broken rather than bounded.
 */
export function nextTab(
  key: string,
  tabs: readonly TabDefinition[],
  active: string,
): string | null {
  if (tabs.length === 0) return null;
  const at = tabs.findIndex((tab) => tab.id === active);
  const from = at === -1 ? 0 : at;
  let index: number;
  switch (key) {
    case 'ArrowRight':
      index = (from + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      index = (from - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      index = 0;
      break;
    case 'End':
      index = tabs.length - 1;
      break;
    default:
      return null;
  }
  return tabs[index]?.id ?? null;
}

/** The panel half. Kept here so the two ids can never drift apart. */
export function TabPanel({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
