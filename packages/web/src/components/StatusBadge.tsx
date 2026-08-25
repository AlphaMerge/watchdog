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
  'down-acknowledged': {
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
  'down-partial': {
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
}: {
  state: SensorState;
  size?: 'sm' | 'md';
}): React.JSX.Element {
  const { label, glyph, classes } = PRESENTATION[state];
  const padding = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-medium ${padding} ${classes}`}
    >
      <span aria-hidden="true">{glyph}</span>
      {label}
    </span>
  );
}
