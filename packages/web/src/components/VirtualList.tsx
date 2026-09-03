import { useCallback, useEffect, useRef, useState } from 'react';
import { visibleRange } from './virtual-list-model';

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  /** Every row is this tall. Fixed on purpose — see below. */
  readonly rowHeight: number;
  readonly height: number;
  /** Rows drawn above and below the window, so a fast scroll does not show blank space. */
  readonly overscan?: number;
  readonly keyOf: (item: T, index: number) => string | number;
  readonly render: (item: T, index: number) => React.ReactNode;
  readonly label: string;
  readonly className?: string;
  /**
   * The container's ARIA role, and the role of each row.
   *
   * Supplied rather than assumed, because only the caller knows what the rows *are*. A tree
   * is not a listbox: `treeitem` carries depth and expansion, `option` carries selection, and
   * announcing one as the other tells a screen-reader user something false about what the
   * arrow keys will do.
   */
  readonly role: 'tree' | 'list' | 'listbox';
  readonly itemRole: 'treeitem' | 'listitem' | 'option';
  /** Per-row ARIA the caller has to supply — `aria-level` for a tree, and nothing for a list. */
  readonly itemProps?: (item: T, index: number) => React.AriaAttributes;
  /**
   * The row that holds the tab stop, for a list the keyboard walks (`U-11`).
   *
   * Supplying it switches the component from one tab stop on the container to a *roving* one:
   * that row is `tabIndex={0}`, every other row is `-1`, and the arrow keys the caller
   * implements move it. Leave it undefined for a list that is only scrolled, which keeps the
   * container focusable and every row out of the tab order.
   */
  readonly activeIndex?: number;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  /**
   * A row took focus by some route other than the arrow keys — a click, or Tab arriving on it.
   *
   * Without this the roving stop and the caller's idea of "where am I" drift apart, and the
   * first arrow key after a click jumps back to wherever the keyboard last was.
   */
  readonly onItemFocus?: (index: number) => void;
}

const DEFAULT_OVERSCAN = 8;

/**
 * A windowed list: only the rows on screen exist in the DOM.
 *
 * **Written rather than installed.** It is forty lines against a dependency, its transitive
 * tree and a version to keep current, and the one property this needs — fixed-height rows in a
 * scrolling box — is the case every such library solves first.
 *
 * **Fixed row height, deliberately.** Measuring rows is what makes virtualisation hard and what
 * makes it janky: the scrollbar changes length as you scroll, and the browser reflows on every
 * measurement. Every row here is a name, a kind and a badge, so they are the same height by
 * construction; a row that needs to be taller belongs on a detail page.
 *
 * **The list stays its full length to a screen reader.** The spacers are `aria-hidden` and every
 * row carries `aria-posinset`/`aria-setsize` against the *whole* list, so "row 400 of 5,000" is
 * still true when only forty rows exist — a virtualised list that silently reports forty is worse
 * than an unvirtualised one. The roles come from the caller for the same reason: this component
 * knows how many rows there are and nothing about what they mean.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  height,
  overscan = DEFAULT_OVERSCAN,
  keyOf,
  render,
  label,
  className,
  role,
  itemRole,
  itemProps,
  activeIndex,
  onKeyDown,
  onItemFocus,
}: VirtualListProps<T>): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const roving = activeIndex !== undefined;

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  // A list that got shorter — a branch collapsed, a filter applied — can leave the viewport
  // scrolled past the end, which renders as an empty box the user has to scroll up out of.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const maximum = Math.max(0, items.length * rowHeight - height);
    if (element.scrollTop > maximum) {
      element.scrollTop = maximum;
      setScrollTop(maximum);
    }
  }, [items.length, rowHeight, height]);

  /*
   * Focus the active row — after scrolling it into the window, because it may not exist yet.
   *
   * This is the one place virtualisation and the keyboard actually collide. `End` on a
   * five-thousand-row tree names a row that is not in the DOM, so `focus()` has nothing to call.
   * Setting `scrollTop` first re-renders the window around it; the effect then runs again with
   * the row mounted and moves focus. Two passes, and both are cheap.
   *
   * **Only when focus is already inside the list.** Otherwise arriving on the page — or a state
   * update while the operator is typing in the search box — would yank focus into the tree.
   */
  useEffect(() => {
    const element = viewport.current;
    if (element === null || activeIndex === undefined) return;
    if (!element.contains(document.activeElement)) return;

    const top = activeIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + height) {
      element.scrollTop = top + rowHeight - height;
    }

    const row = element.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`);
    row?.focus({ preventScroll: true });
  }, [activeIndex, rowHeight, height, scrollTop]);

  const window = visibleRange({ count: items.length, rowHeight, height, scrollTop, overscan });
  const visible = items.slice(window.start, window.end);

  return (
    <div
      ref={viewport}
      onScroll={onScroll}
      style={{ height: `${String(height)}px` }}
      className={`overflow-y-auto ${className ?? ''}`}
      role={role}
      aria-label={label}
      // With a roving tab stop the container must not be one too, or Tab lands on the box and
      // then again on the row inside it, and the arrow keys do nothing on the first of those.
      tabIndex={roving ? undefined : 0}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: `${String(window.start * rowHeight)}px` }} aria-hidden="true" />
      {visible.map((item, offset) => (
        <div
          key={keyOf(item, window.start + offset)}
          data-index={window.start + offset}
          className={roving ? 'ms-roving-row' : undefined}
          style={{ height: `${String(rowHeight)}px` }}
          role={itemRole}
          aria-posinset={window.start + offset + 1}
          aria-setsize={items.length}
          {...(roving
            ? {
                tabIndex: window.start + offset === activeIndex ? 0 : -1,
                onFocus: () => {
                  onItemFocus?.(window.start + offset);
                },
              }
            : {})}
          {...itemProps?.(item, window.start + offset)}
        >
          {render(item, window.start + offset)}
        </div>
      ))}
      <div
        style={{ height: `${String(Math.max(0, items.length - window.end) * rowHeight)}px` }}
        aria-hidden="true"
      />
    </div>
  );
}
