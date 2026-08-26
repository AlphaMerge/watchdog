import { useCallback, useEffect, useRef, useState } from 'react';

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
}: VirtualListProps<T>): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

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
      tabIndex={0}
    >
      <div style={{ height: `${String(window.start * rowHeight)}px` }} aria-hidden="true" />
      {visible.map((item, offset) => (
        <div
          key={keyOf(item, window.start + offset)}
          style={{ height: `${String(rowHeight)}px` }}
          role={itemRole}
          aria-posinset={window.start + offset + 1}
          aria-setsize={items.length}
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

/** Which rows a viewport of this height, scrolled this far, actually needs. Pure, so it is tested. */
export function visibleRange(options: {
  count: number;
  rowHeight: number;
  height: number;
  scrollTop: number;
  overscan: number;
}): { start: number; end: number } {
  const { count, rowHeight, height, scrollTop, overscan } = options;
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const onScreen = Math.ceil(height / rowHeight) + 1;
  // Clamped into the list, not merely at zero. A list that got shorter — a branch collapsed, a
  // search applied — leaves the viewport scrolled past the end for one frame, and a window that
  // started past the last row would render nothing at all.
  const start = Math.min(Math.max(0, first - overscan), Math.max(0, count - 1));
  const end = Math.min(count, Math.max(start + 1, first + onScreen + overscan));
  return { start, end };
}
