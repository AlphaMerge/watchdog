/**
 * Separate from the component so the clamping — the part that can be quietly wrong — is tested
 * on its own, and so a module exporting a component and a function does not block Fast Refresh.
 */

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
