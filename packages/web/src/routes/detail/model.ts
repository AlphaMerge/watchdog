import type {
  ChannelRecord,
  HistoryChannel,
  SensorValues,
  SettingView,
  TriggerKind,
} from '../../api/types';
import type { ChartGroup } from '@ms/shared/charts';
import type { TabDefinition } from '../../components/tabs-model';
import { labelFor, seedDefaults, type FieldModel, type JsonSchema } from '../../forms/schema';

/**
 * The detail page's pure logic, for the same reason `src/tree/model.ts` exists: the panels are
 * components, and these are the judgements inside them — how many decimal places a reading is
 * honestly worth, what a range summary says when every bucket is a gap, what a screen reader is
 * told instead of a canvas. `test/detail-model.test.ts` and `test/settings-field.test.ts` assert
 * them without rendering a panel.
 *
 * Gathered here rather than left beside each panel because a module that exports both a component
 * and a function cannot Fast Refresh — editing any of the five would reload the page instead of
 * hot-updating it.
 */

// ---------------------------------------------------------------------------------------------
// The page's sections (U-04, U-21).
// ---------------------------------------------------------------------------------------------

/**
 * Which sections this kind actually has. A device has no channels and no history, and a sensor
 * stores no credential set: it uses the one in force on its device, which is where that is read
 * and changed (`U-21`).
 */
export function tabsFor(detail: { kind: string }): TabDefinition[] {
  const tabs: TabDefinition[] = [{ id: 'overview', label: 'Overview' }];
  if (detail.kind === 'sensor') tabs.push({ id: 'history', label: 'History' });
  tabs.push({ id: 'log', label: 'Log' }, { id: 'settings', label: 'Settings' });
  if (detail.kind !== 'sensor') tabs.push({ id: 'credentials', label: 'Credentials' });
  tabs.push({ id: 'triggers', label: 'Triggers' }, { id: 'changes', label: 'Changes' });
  return tabs;
}

// ---------------------------------------------------------------------------------------------
// Channel readings (U-04).
// ---------------------------------------------------------------------------------------------

/**
 * How many decimal places an automatic-precision value gets.
 *
 * **Three significant digits, not six decimal places.** A stored reading of `0.223 ms` and a
 * 45-minute average of `0.20335648…` are the same channel, and printing the second one in full
 * claims a precision the average does not have — six digits of it manufactured by division. The
 * places move with the magnitude so a small value keeps its digits: `0.000412` stays
 * `0.000412` rather than rounding to `0.000`, which would read as a zero.
 */
export function automaticDecimals(value: number): number {
  const size = Math.abs(value);
  if (size === 0) return 0;
  if (size >= 100) return 0;
  if (size >= 10) return 1;
  if (size >= 1) return 2;
  // Below one: enough places for three significant digits, capped so a denormal cannot ask for
  // forty of them.
  return Math.min(8, 2 - Math.floor(Math.log10(size)));
}

/**
 * Formats a reading the way its channel is configured to show it (`M-07`).
 *
 * `decimals: null` means automatic — see `automaticDecimals`. A configured precision is honoured
 * exactly, padding included, because a channel set to two places wants `0.20` and not `0.2`.
 */
export function formatValue(value: number, unit: string, decimals: number | null): string {
  const shown =
    decimals === null
      ? new Intl.NumberFormat(undefined, {
          maximumFractionDigits: automaticDecimals(value),
        }).format(value)
      : new Intl.NumberFormat(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);
  return unit === '' ? shown : `${shown} ${unit}`;
}

/** How long ago, in words, for a reading whose exact instant is a tooltip away. */
export function howLongAgo(at: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1_000));
  if (seconds < 90) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

/**
 * An answer from `/values`, as it reads `heldMs` after it arrived (`U-71`).
 *
 * The page keeps its last readings in sight while the next are read, and when a read fails, for as
 * long as the reads keep failing. The core answered with only what was current then: nothing taken
 * before `notBefore` (three scan intervals before `readAt`). A reading held past that window is no
 * longer current, and showing it as one is no-data wearing a number. So the window moves on with
 * the time the answer has been held, and a reading that falls out of it is taken out (`value` and
 * `at` null), which the table says as it says any other: *no recent reading*, or *not read* for a
 * retired channel. **Held time, not the age of the reading by the browser's clock**: both ends of
 * the comparison are the core's timestamps, moved by an interval measured here, so a browser whose
 * clock is minutes off the core's neither drops current readings nor keeps stale ones.
 */
export function heldReadings(values: SensorValues, heldMs: number): SensorValues {
  if (heldMs <= 0) return values;
  const notBefore = Date.parse(values.notBefore) + heldMs;
  return {
    ...values,
    channels: values.channels.map((channel) =>
      channel.at !== null && Date.parse(channel.at) < notBefore
        ? { ...channel, value: null, at: null }
        : channel,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// State log (M-15).
// ---------------------------------------------------------------------------------------------

/** A duration in the largest unit that still says something useful. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  if (seconds < 90) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

// ---------------------------------------------------------------------------------------------
// History (U-05).
// ---------------------------------------------------------------------------------------------

/**
 * The three ranges PRTG's sensor page offers, and this one does too (`CAPABILITIES.MD §8`).
 *
 * They are not arbitrary: two days is "what happened on my shift", thirty is "is this getting
 * worse", a year is "what do I tell the auditor". The resolution is left to the server, which
 * has rules about it (`S-08`) and reports what it changed.
 */
export const RANGES = [
  { id: '2d', label: '2 days', days: 2 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '365d', label: '365 days', days: 365 },
] as const;

export type RangeId = (typeof RANGES)[number]['id'];

/** The newest reading a channel has in this range, or null when it ends in a gap. */
export function lastReading(channel: HistoryChannel): number | null {
  for (let index = channel.avg.length - 1; index >= 0; index -= 1) {
    const value = channel.avg[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** The one-line range summary beside a panel heading. */
export function summarise(group: ChartGroup, extent: { low: number; high: number } | null): string {
  const buckets = group.series[0]?.channel.avg.length ?? 0;
  const gaps = group.series.reduce(
    (worst, { channel }) => Math.max(worst, channel.avg.filter((value) => value === null).length),
    0,
  );
  const unit = group.unit;
  const range =
    extent === null
      ? 'no readings in this range'
      : extent.low === extent.high
        ? // "0 % to 0 %" is a worse sentence than the one fact it contains — and quoting a
          // padded drawing scale here would invent a reading nobody took.
          `steady at ${formatValue(extent.low, unit, null)}`
        : `${formatValue(extent.low, unit, null)} to ${formatValue(extent.high, unit, null)}`;
  if (gaps === 0 || buckets === 0) return range;
  return `${range} · ${gaps.toLocaleString()} of ${buckets.toLocaleString()} buckets are gaps`;
}

/** What a screen reader is told instead of the canvas. */
export function describe(
  group: ChartGroup,
  buckets: readonly string[],
  extent: { low: number; high: number } | null,
): string {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const period =
    first === undefined || last === undefined
      ? ''
      : ` from ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}`;
  const names = group.series.map(({ channel }) => channel.name).join(', ');
  return `Line chart of ${names}${period}. ${summarise(group, extent)}. The same readings are in the table view.`;
}

export function formatSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${String(seconds / 86_400)}d`;
  if (seconds % 3_600 === 0) return `${String(seconds / 3_600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}

// ---------------------------------------------------------------------------------------------
// Inherited settings (U-09).
// ---------------------------------------------------------------------------------------------

/**
 * A `FieldModel` for one setting.
 *
 * Built by hand rather than through `fieldsOf`, because a setting's key is dotted —
 * `scan.intervalSeconds` — and the path machinery would read that as nesting. The setting is one
 * value at one key; the dots are a namespace, not a structure.
 */
export function fieldFor(setting: SettingView, prefix: string): FieldModel {
  const schema = setting.schema as JsonSchema;
  const type = Array.isArray(schema.type)
    ? schema.type.find((entry) => entry !== 'null')
    : schema.type;
  const nullable = Array.isArray(schema.type) && schema.type.includes('null');

  return {
    path: setting.key,
    name: setting.key,
    label: labelFor(setting.key.slice(prefix.length + 1)),
    description: setting.description,
    kind:
      schema.enum !== undefined && schema.enum.length > 0
        ? 'enum'
        : type === 'integer'
          ? 'integer'
          : type === 'number'
            ? 'number'
            : type === 'boolean'
              ? 'boolean'
              : type === 'string'
                ? 'string'
                : 'json',
    schema,
    // A nullable setting is one whose "not set" is a value — `schedule.id: null` means "always".
    // Calling it required would make that unreachable through the control.
    required: !nullable,
    writeOnly: false,
    createOnly: false,
    entry: false,
    children: [],
    // Never an array: a setting is one value at one key, and `U-12`'s repeating control is for a
    // sensor type's parameters. An array-typed setting falls to the JSON box above.
    items: undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Triggers (N-05).
// ---------------------------------------------------------------------------------------------

/** A kind's settings pre-filled from the defaults its schema declares. */
export function seedFrom(kind: TriggerKind | undefined): Record<string, unknown> {
  return seedDefaults(kind?.settingsSchema ?? {});
}

// ---------------------------------------------------------------------------------------------
// Parameters (U-34).
// ---------------------------------------------------------------------------------------------

/** One channel an edit would have turned into the other mode, as the core names it (`P-303`). */
export interface ModeChange {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The channels a `409 OBJECT_CHANNEL_MODE_FIXED` names, or `null` for any other refusal.
 *
 * **Still reachable with the form doing its part.** A field marked `x-createOnly` is read-only
 * for an entry the sensor has, but a table column taken out by one edit keeps its channel, and
 * putting it back as the other mode is an entry the stored parameters no longer name — so the
 * form leaves it open and the core refuses it. A stale form, or another writer, gets here too.
 *
 * Read defensively: `details` is whatever the core sent, and a list item missing a field is
 * dropped rather than shown as "undefined into a undefined".
 */
export function modeChangesOf(error: {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
}): readonly ModeChange[] | null {
  if (error.status !== 409 || error.code !== 'OBJECT_CHANNEL_MODE_FIXED') return null;
  const raw = error.details['channels'];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { key, from, to } = entry as Record<string, unknown>;
    return typeof key === 'string' && typeof from === 'string' && typeof to === 'string'
      ? [{ key, from, to }]
      : [];
  });
}

// ---------------------------------------------------------------------------------------------
// The channel list kept current (U-55).
// ---------------------------------------------------------------------------------------------

/**
 * Whether the channel list the page holds has gone stale (`U-55`, `U-61`).
 *
 * The page reads the list once, when it opens, and polls `/values`, which carries the list's own
 * `retired` from the same derivation (`U-38`). A channel is retired until a reading newer than
 * the sensor's last change arrives (`P-322`), so the poll is where the page learns a retired
 * channel is read again: `/values` answers `false` for a channel the list still holds as
 * retired. The other way round is an edit made elsewhere since the page opened. Either way the
 * list is re-read; an ordinary poll, on which the two agree, asks for nothing more.
 *
 * Compared on `retired`, not on whether a reading is present: a reading a probe took before the
 * edit is still shown while it is recent, and it does not make the channel live, so a re-read
 * for it would answer the same and be asked for again.
 *
 * **A channel `/values` names and the list does not hold is stale too** (`U-61`): an edit since
 * the page opened gave the sensor a channel (a table column added), and the list read before it
 * has no row for it, so it stayed out of the table until a reload. Its `retired` is not compared
 * — `false` is what the route says of a channel it has not worked out — only that the list lacks
 * it. Both answers come from the sensor's own channel rows, so a list read after the poll holds
 * it and the next poll agrees; the page's once-a-minute bound covers a list read just before the
 * channel was made.
 */
export function channelListIsStale(list: readonly ChannelRecord[], values: SensorValues): boolean {
  const held = new Map(list.map((channel) => [channel.id, channel.retired]));
  return values.channels.some((channel) => {
    const retired = held.get(channel.id);
    return retired === undefined || retired !== channel.retired;
  });
}

/**
 * The least time between two re-reads of the channel list (`U-55`). A channel whose retirement
 * flips back and forth, or a list and a poll that keep disagreeing, re-read it at most this
 * often, however often the page polls (a hidden tab brought back polls at once).
 */
export const RELIST_MIN_MS = 60_000;
