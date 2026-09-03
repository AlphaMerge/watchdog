import { useCallback, useEffect, useRef, useState } from 'react';

export interface ComboboxOption {
  /** What lands in the box when this is picked. Also the option's identity in the list. */
  readonly value: string;
  /** How it reads, when that is richer than the value — a marked-up match, usually. */
  readonly label?: React.ReactNode;
  /** A one-word chip saying what kind of thing this is. */
  readonly badge?: string;
  /** The right-hand hint: what picking it will do. */
  readonly detail?: string;
}

export interface ComboboxProps {
  readonly id: string;
  /** Named for screen readers. The box itself shows the placeholder, as the tree's search does. */
  readonly label: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Picked from the list — by Enter, or by click. Typing alone never calls this. */
  readonly onPick: (option: ComboboxOption) => void;
  readonly options: readonly ComboboxOption[];
  readonly className?: string;
}

/**
 * A text box that suggests, keyboard and all — the ARIA "combobox with list autocomplete".
 *
 * **The list never takes over the box.** What is typed stays typed: moving through suggestions
 * with the arrow keys does not rewrite the field, and nothing is chosen until Enter or a click.
 * The alternative — the box completing itself as you arrow past each option — reads well in a
 * demo and is hostile in practice, because it makes *looking* at the third suggestion identical
 * to *choosing* it, and there is no way back to what you were typing.
 *
 * **`aria-activedescendant`, not focus.** Focus stays in the input while the active option moves,
 * which is what lets somebody keep typing to narrow a list they are already halfway down. Moving
 * real focus into the list would end the edit on the first arrow key.
 *
 * Escape is two-stage: shut the list, and shut it again to clear the field. That is the ARIA
 * authoring practice, and it is the one keystroke that always gets back to the unfiltered page.
 */
export function Combobox({
  id,
  label,
  placeholder,
  value,
  onChange,
  onPick,
  options,
  className = '',
}: ComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = `${id}-listbox`;
  const optionId = (index: number): string => `${id}-option-${String(index)}`;

  // A narrowed list can be shorter than where the cursor was. Nothing is "still" active then,
  // and leaving the index where it was would point `aria-activedescendant` at an id that no
  // longer exists — a screen reader announces silence, which reads as a broken control.
  const count = options.length;
  useEffect(() => {
    setActive((was) => (was >= count ? -1 : was));
  }, [count]);

  useEffect(() => {
    if (!open || active < 0) return;
    const element = list.current?.children[active];
    // jsdom has no layout, so no scrollIntoView. The behaviour is real and the guard is cheap.
    if (element instanceof HTMLElement && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active]);

  const pick = useCallback(
    (option: ComboboxOption) => {
      setOpen(false);
      setActive(-1);
      onPick(option);
    },
    [onPick],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          if (count === 0) return;
          event.preventDefault();
          setOpen(true);
          const down = event.key === 'ArrowDown';
          setActive((was) =>
            // From nothing active, down enters at the top and up enters at the bottom; after
            // that it wraps, as a menu does. Stopping dead at the end of ten suggestions makes
            // a keyboard user think the key stopped working.
            was < 0 ? (down ? 0 : count - 1) : (was + (down ? 1 : -1) + count) % count,
          );
          return;
        }
        case 'Home':
        case 'End': {
          if (!open || count === 0) return;
          event.preventDefault();
          setActive(event.key === 'Home' ? 0 : count - 1);
          return;
        }
        case 'Enter': {
          const option = open && active >= 0 ? options[active] : undefined;
          if (option === undefined) return;
          // Only when a suggestion is taken: a bare Enter belongs to the form, and to anybody
          // who typed a query the list does not contain.
          event.preventDefault();
          pick(option);
          return;
        }
        case 'Escape': {
          event.preventDefault();
          if (open) {
            setOpen(false);
            setActive(-1);
          } else {
            onChange('');
          }
          return;
        }
        case 'Tab': {
          setOpen(false);
          setActive(-1);
          return;
        }
        default:
          return;
      }
    },
    [open, active, count, options, pick, onChange],
  );

  return (
    <div
      ref={wrapper}
      className={`relative ${className}`}
      onBlur={(event) => {
        // Only when focus has actually left the control — a click on an option moves focus
        // within it, and closing on every blur would shut the list before the click landed.
        if (!wrapper.current?.contains(event.relatedTarget)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className="w-full min-w-0 border border-control bg-surface px-2 py-1 text-sm text-text placeholder:text-text-muted"
      />
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={label}
        // Rendered whether or not it is open, because `aria-controls` must point at something
        // that exists; `hidden` is what tells everybody, assistive technology included, that it
        // is shut.
        hidden={!open || count === 0}
        /* Floats over content, so it gets the same restrained shadow as the chart tooltip —
           and the control border rather than the divider grey, because its edge is what tells
           you where the list ends. */
        className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto border border-control bg-surface py-1 shadow-[0_2px_10px_rgb(27_26_23_/_0.14)]"
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => {
              // Before the blur that a mousedown would otherwise cause: the click needs the
              // list to still be open when it lands.
              event.preventDefault();
            }}
            onClick={() => {
              pick(option);
            }}
            onMouseMove={() => {
              setActive(index);
            }}
            // Spelled out rather than left to the content, because a `label` with the matched
            // substring marked inside it computes to "snmp .traf fic" — the mark splits the name
            // into pieces, and the announcement changes with every keystroke.
            aria-label={[option.badge, option.value, option.detail].filter(Boolean).join(', ')}
            className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${
              index === active ? 'bg-accent text-accent-contrast' : 'text-text'
            }`}
          >
            {option.badge !== undefined && (
              <span
                className={`shrink-0 px-1 py-0.5 text-xs ${
                  index === active ? '' : 'bg-surface-muted text-text-muted'
                }`}
              >
                {option.badge}
              </span>
            )}
            <span className="truncate font-mono">{option.label ?? option.value}</span>
            {option.detail !== undefined && (
              <span
                className={`ml-auto shrink-0 text-xs ${index === active ? '' : 'text-text-muted'}`}
              >
                {option.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
