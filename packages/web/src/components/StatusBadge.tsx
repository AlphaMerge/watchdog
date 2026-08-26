import type { SensorState } from '../api/types';

interface Presentation {
  label: string;
  /** A distinct shape per state. Colour alone would fail WCAG 1.4.1 for a colour-blind user. */
  glyph: string;
  classes: string;
}

const PRESENTATION: Record<SensorState, Presentation> = {
  up: { label: 'Up', glyph: '●', classes: 'bg-up-bg text-up-fg border-up-border' },
  warning: {
    label: 'Warning',
    glyph: '▲',
    classes: 'bg-warning-bg text-warning-fg border-warning-border',
  },
  down: { label: 'Down', glyph: '■', classes: 'bg-down-bg text-down-fg border-down-border' },
  down_acknowledged: {
    label: 'Down (acknowledged)',
    glyph: '◆',
    classes: 'bg-ack-bg text-ack-fg border-ack-border',
  },
  paused: {
    label: 'Paused',
    glyph: '‖',
    classes: 'bg-paused-bg text-paused-fg border-paused-border',
  },
  unknown: {
    label: 'Unknown',
    glyph: '○',
    classes: 'bg-unknown-bg text-unknown-fg border-unknown-border',
  },
  // [V2]. Rendered in the neutral palette rather than a colour nothing can produce yet.
  unusual: {
    label: 'Unusual',
    glyph: '◇',
    classes: 'bg-unknown-bg text-unknown-fg border-unknown-border',
  },
  down_partial: {
    label: 'Down (partial)',
    glyph: '◧',
    classes: 'bg-unknown-bg text-unknown-fg border-unknown-border',
  },
};

/**
 * A sensor state, as three redundant signals: colour, shape and the word itself.
 *
 * The word is not decoration. An operator scanning a tree of 5,000 rows reads shape and colour,
 * but a screen reader reads text, and a monochrome printout has neither of the first two.
 */
export function StatusBadge({
  state,
  size = 'md',
  describedAs,
}: {
  state: SensorState;
  size?: 'sm' | 'md';
  /**
   * What this badge *means*, when it is not the plain reading.
   *
   * `U-03` needs it: a group's badge is the worst state anywhere beneath it, and a screen reader
   * announcing "Down" on a group would say the group is down. Sighted users get the same
   * distinction from the row it sits on; this is how everybody else does.
   */
  describedAs?: string;
}): React.JSX.Element {
  const { label, glyph, classes } = PRESENTATION[state];
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-medium ${padding} ${classes}`}
      {...(describedAs === undefined ? {} : { role: 'img', 'aria-label': describedAs })}
    >
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
