import { useId } from 'react';
import { Link } from 'react-router-dom';
import type { ChannelRecord, ChannelValue, LookupSummary, SensorValues } from '../../api/types';
import { Empty } from '../../components/Panels';
import { channelLinkFor } from './credentials-model';
import { formatValue, howLongAgo } from './model';

/**
 * What a retired channel is (`P-310`), wherever the table says so. Its history stays on the
 * History tab, where the line stops at the edit rather than falling to zero.
 */
const RETIRED =
  'An edit took this channel out of the sensor’s parameters, so nothing reads it any more and ' +
  'it judges nothing. Its history is kept; put it back to read it again.';

/**
 * The channel table (`U-04`) — what each channel reads, and what judges it.
 *
 * **An absent reading is stated, never blank and never zero.** The core withholds anything older
 * than three scan intervals, so a null here means the channel has actually stopped reporting;
 * printing the last known number would tell an operator a Down sensor is fine, which is the
 * failure this whole system exists to prevent. A real zero — packet loss of 0% — prints as `0`,
 * and the two are visibly different.
 */
export function ChannelTable({
  channels,
  sensorType,
  values,
  lookups,
  now,
}: {
  channels: readonly ChannelRecord[];
  /** The sensor's type, for a channel whose number has a page that lists what it counts. */
  sensorType?: string | undefined;
  values: SensorValues | null;
  lookups: readonly LookupSummary[] | null;
  now: number;
}): React.JSX.Element {
  // Before the early return: a hook is called on every render or on none.
  const retiredNote = useId();
  if (channels.length === 0) {
    return (
      <Empty because="A sensor type declares its channels, so they exist from the moment the sensor does (P-05).">
        No channels.
      </Empty>
    );
  }

  const byId = new Map<number, ChannelValue>(
    (values?.channels ?? []).map((channel) => [channel.id, channel]),
  );
  // What `retired` and `not read` mean, as text on the page and as the description of each
  // retired row's header and reading. A title alone reaches nobody who cannot hover: not a
  // keyboard, not a touch screen, not a screen reader.
  const anyRetired = channels.some((channel) => channel.retired);
  const describedBy = (channel: ChannelRecord): string | undefined =>
    channel.retired ? retiredNote : undefined;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">
          Channels, their current readings and the thresholds each is judged against
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Channel
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Reading
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Judged by
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {channels.map((channel) => (
            <tr key={channel.id}>
              <th
                scope="row"
                className="py-2 pr-3 text-left font-normal"
                aria-describedby={describedBy(channel)}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      channel.retired ? 'font-medium text-text-muted' : 'font-medium text-text'
                    }
                  >
                    {channel.name}
                  </span>
                  <span className="font-mono text-xs text-text-muted">{channel.key}</span>
                  {channel.isPrimary && (
                    <span
                      className="border border-border px-1.5 py-0.5 text-xs text-text-muted"
                      title="The channel whose state is the sensor's state"
                    >
                      primary
                    </span>
                  )}
                  {channel.retired && (
                    <span
                      className="border border-border px-1.5 py-0.5 text-xs text-text-muted"
                      title={RETIRED}
                    >
                      retired
                    </span>
                  )}
                  <Processing channel={channel} />
                  <CountedOn sensorType={sensorType} channelKey={channel.key} />
                </span>
              </th>
              <td
                className="py-2 pr-3 text-right align-top"
                aria-describedby={describedBy(channel)}
              >
                <Reading
                  channel={channel}
                  value={byId.get(channel.id) ?? null}
                  intervalSeconds={values?.intervalSeconds ?? null}
                  now={now}
                />
              </td>
              <td className="py-2 pr-3 align-top">
                <Judgement channel={channel} lookups={lookups} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyRetired && (
        <p id={retiredNote} className="mt-2 text-xs text-text-muted">
          <span className="font-medium">Retired:</span> {RETIRED}
        </p>
      )}
    </div>
  );
}

function Reading({
  channel,
  value,
  intervalSeconds,
  now,
}: {
  channel: ChannelRecord;
  value: ChannelValue | null;
  intervalSeconds: number | null;
  now: number;
}): React.JSX.Element {
  // A reading taken before the edit is still a reading, and shows as one until it ages out.
  // After that "no recent reading" would read as an outage, which this is not.
  if (channel.retired && (value === null || value.value === null || value.at === null)) {
    return (
      <span className="text-text-muted" title={RETIRED}>
        not read
      </span>
    );
  }
  if (value === null) return <span className="text-text-muted">—</span>;
  if (value.value === null || value.at === null) {
    const window =
      intervalSeconds === null ? 'the current window' : `${String(intervalSeconds * 3)}s`;
    return (
      <span className="text-text-muted" title={`Nothing recorded within ${window}`}>
        no recent reading
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end">
      <span className="font-mono tabular-nums text-text">
        {formatValue(value.value, channel.unit, channel.decimals)}
      </span>
      <time className="text-xs text-text-muted" dateTime={value.at} title={value.at}>
        {howLongAgo(value.at, now)}
      </time>
    </span>
  );
}

/**
 * The page that lists what a channel counts, where there is one (`U-21`).
 *
 * A count says how many and not which. Core Health's **Credential sets without targets** was the
 * only place an operator learned a set had no bounds, and it could not say which set.
 */
function CountedOn({
  sensorType,
  channelKey,
}: {
  sensorType: string | undefined;
  channelKey: string;
}): React.JSX.Element | null {
  const link = channelLinkFor(sensorType, channelKey);
  if (link === null) return null;
  return (
    <Link to={link.to} className="text-xs text-accent hover:underline">
      {link.label} →
    </Link>
  );
}

/**
 * What decides this channel's state: a lookup, or its limits — never both (`M-06`).
 *
 * A channel naming a lookup this installation has not loaded says so. That is a real situation
 * with a real consequence — the channel reads Warning and nothing can interpret it — and it is
 * exactly what a UI showing only the id would hide.
 */
function Judgement({
  channel,
  lookups,
}: {
  channel: ChannelRecord;
  lookups: readonly LookupSummary[] | null;
}): React.JSX.Element {
  if (channel.lookupId !== null) {
    const known = lookups === null || lookups.some((lookup) => lookup.id === channel.lookupId);
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span className="font-mono">{channel.lookupId}</span>
        {!known && (
          <span className="border border-warning-border bg-warning-bg px-1.5 py-0.5 text-warning-fg">
            not loaded
          </span>
        )}
      </span>
    );
  }
  return <LimitBand channel={channel} />;
}

/**
 * The thresholds a channel is judged against (`M-04`), from the outside in.
 *
 * Ordered the way the number line is — lower error, lower warning, upper warning, upper error —
 * so the band an operator wants the reading to stay inside is the gap in the middle, and reads
 * as one thing rather than four independent facts. Read-only here; `U-08` generates the form.
 */
function LimitBand({ channel }: { channel: ChannelRecord }): React.JSX.Element {
  const { limits, unit, decimals } = channel;
  // At the channel's own precision, because a limit shown as "500" on a channel reading "499.98"
  // reads like a threshold nobody crossed.
  const show = (value: number): string => formatValue(value, unit, decimals);
  const parts: string[] = [];
  if (limits.lowerError !== null) parts.push(`error < ${show(limits.lowerError)}`);
  if (limits.lowerWarning !== null) parts.push(`warn < ${show(limits.lowerWarning)}`);
  if (limits.upperWarning !== null) parts.push(`warn > ${show(limits.upperWarning)}`);
  if (limits.upperError !== null) parts.push(`error > ${show(limits.upperError)}`);
  if (parts.length === 0) return <span className="text-xs text-text-muted">nothing</span>;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
      <span className="font-mono">{parts.join(' · ')}</span>
      {/* Configured but not acting. Saying so beats showing thresholds that do nothing. */}
      {!limits.enabled && <span className="border border-border px-1.5 py-0.5">not enforced</span>}
    </span>
  );
}

/**
 * What happens to a reading before anything judges it (`M-07`).
 *
 * Beside the name, because it changes what the number means: a channel scaled by 8 is not
 * reporting what the device sent, and an operator comparing it with anything else has to know.
 */
function Processing({ channel }: { channel: ChannelRecord }): React.JSX.Element | null {
  const parts: string[] = [];
  if (channel.scaleMul !== '1') parts.push(`×${channel.scaleMul}`);
  if (channel.scaleDiv !== '1') parts.push(`÷${channel.scaleDiv}`);
  if (channel.spikeMin !== null || channel.spikeMax !== null) {
    const low = channel.spikeMin === null ? '' : String(channel.spikeMin);
    const high = channel.spikeMax === null ? '' : String(channel.spikeMax);
    parts.push(`spike ${low}–${high}`);
  }
  if (parts.length === 0) return null;

  return (
    <span
      className="border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted"
      title="Applied before the reading is stored or judged"
    >
      {parts.join(' ')}
    </span>
  );
}
