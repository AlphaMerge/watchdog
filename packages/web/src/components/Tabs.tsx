import { useCallback, useRef } from 'react';
import { nextTab, type TabDefinition } from './tabs-model';

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
            className={`-mb-px rounded-t border-b-2 px-3 py-2 text-sm ${
              selected
                ? 'border-accent font-medium text-text'
                : 'border-transparent text-text-muted hover:text-text'
            }`}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="ml-1.5 tabular-nums text-xs text-text-muted">{tab.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
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
