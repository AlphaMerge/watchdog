import type { SensorState } from '../../state/tables.js';

/** Adaptive Cards' fixed palette. A chat client picks the actual shade from its own theme. */
export type CardTone = 'good' | 'warning' | 'attention' | 'accent' | 'default';

export interface StatusStyle {
  /** For the methods that take a colour of their own — Slack's bar, Teams' theme colour. */
  readonly colour: string;
  readonly tone: CardTone;
  /** The state in words, so a colour is never the only thing carrying the meaning. */
  readonly label: string;
  /** A glyph, which is what the eye finds in a busy channel. Never on its own. */
  readonly glyph: string;
}

/**
 * How a state looks in a chat message (`N-09`).
 *
 * **Colour is never the only signal.** Every card built from this puts the glyph, the word and
 * the colour together — one in eight men has some form of colour blindness, chat clients recolour
 * everything in dark mode, and a red bar in a phone notification preview is not visible at all.
 * WCAG 2.1 1.4.1 says the same thing about our own UI and the reasoning does not stop at the
 * boundary of software we wrote.
 *
 * The colours are the conventional traffic-light reading, with the two states that are neither
 * clearly good nor clearly bad kept off the red-amber-green scale entirely: violet for `unusual`
 * and grey for the states where nothing is being measured. Grey for paused matters — the alarm
 * that arrives *because* a sensor was paused must not look like an outage.
 */
const STYLES: Readonly<Record<SensorState, StatusStyle>> = {
  up: { colour: '#2eb886', tone: 'good', label: 'Up', glyph: '🟢' },
  warning: { colour: '#e8a33d', tone: 'warning', label: 'Warning', glyph: '🟡' },
  down: { colour: '#d63a3a', tone: 'attention', label: 'Down', glyph: '🔴' },
  // Still down, and it says so. An acknowledgement stops the repeats (`WORKFLOW.MD §5`); it does
  // not make the thing work, and a card that implied otherwise would be lying to a channel.
  down_acknowledged: {
    colour: '#a35252',
    tone: 'attention',
    label: 'Down (acknowledged)',
    glyph: '🔴',
  },
  down_partial: { colour: '#e8734a', tone: 'warning', label: 'Partially down', glyph: '🟠' },
  unusual: { colour: '#7a5cd6', tone: 'accent', label: 'Unusual', glyph: '🟣' },
  paused: { colour: '#8a8f98', tone: 'default', label: 'Paused', glyph: '⚪' },
  unknown: { colour: '#8a8f98', tone: 'default', label: 'Unknown', glyph: '⚫' },
};

export function styleOf(state: SensorState): StatusStyle {
  return STYLES[state];
}

/** The theme colour without its `#`, which is how Teams' MessageCard has always written one. */
export function bareColour(colour: string): string {
  return colour.replace(/^#/, '').toUpperCase();
}
