import type { HistoryChannel } from '../api/types';

const MAX_ROWS = 500;

/**
 * The table view — every chart's WCAG-clean twin.
 *
 * **Not a fallback, an equal.** Three of the eight light-mode series colours sit below 3:1
 * against white; the `dataviz` validator calls that a WARN whose relief is mandatory, and this
 * is the relief. It is also the answer for a canvas, which carries no text a screen reader can
 * reach — the chart is `aria-hidden` decoration over data that lives here.
 *
 * A gap is a row that says so. Omitting the row would compress the time axis and make an outage
 * look like it never happened; a dash in a cell says the sensor produced nothing at that bucket,
 * which is what actually occurred.
 */
export function SeriesTable({
  channels,
  buckets,
  format,
  caption,
}: {
  channels: readonly HistoryChannel[];
  buckets: readonly string[];
  format: (channel: HistoryChannel, value: number) => string;
  caption: string;
}): React.JSX.Element {
  // Newest first: the question a table is opened with is almost always about the recent end.
  const order = Array.from({ length: buckets.length }, (_, index) => index).reverse();
  const shown = order.slice(0, MAX_ROWS);

  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full min-w-[30rem] text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-left uppercase tracking-wide text-text-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Bucket
            </th>
            {channels.map((channel) => (
              <th key={channel.id} scope="col" className="py-1.5 pr-3 text-right font-medium">
                {channel.name}
                {channel.unit !== '' && <span className="ml-1">({channel.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {shown.map((index) => {
            const at = buckets[index];
            return (
              <tr key={at ?? index}>
                <th scope="row" className="py-1 pr-3 text-left font-normal text-text-muted">
                  {at === undefined ? '' : new Date(at).toLocaleString()}
                </th>
                {channels.map((channel) => {
                  const value = channel.avg[index] ?? null;
                  return (
                    <td key={channel.id} className="py-1 pr-3 text-right tabular-nums text-text">
                      {value === null ? (
                        <span className="text-text-muted" title="No reading in this bucket">
                          —
                        </span>
                      ) : (
                        format(channel, value)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {order.length > shown.length && (
        <p className="mt-2 text-xs text-text-muted">
          The most recent {String(MAX_ROWS)} of {order.length.toLocaleString()} buckets. Narrow the
          range to see the rest.
        </p>
      )}
    </div>
  );
}
