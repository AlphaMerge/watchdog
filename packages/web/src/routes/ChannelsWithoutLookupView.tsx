import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { ChannelsWithoutLookup } from '../api/types';
import { PageTitle } from '../components/PageTitle';
import { Card, Empty } from '../components/Panels';
import { summary, WITHOUT_LOOKUP_PATH } from './channels-without-lookup';
import { ReadState } from '../components/ReadRegion';

/**
 * The channels without the lookup their type declares (`P-308`): status channels judged by
 * nothing, as a list for an operator to work through.
 *
 * **Listed, never filled, and the page says why.** Most are channels a clone made before
 * `P-302` lost, but an empty lookup may also be one somebody cleared so that a shut port stays
 * quiet, and nothing recorded tells the two apart. Each row goes to its sensor, whose channel
 * table sets a lookup, offering the declared one first (`U-82`).
 *
 * **Only the sensors this reader can see**, and at most the core's first thousand, with the
 * total said when the list is cut.
 */
export function ChannelsWithoutLookupView(): React.JSX.Element {
  const list = useApi<ChannelsWithoutLookup>(WITHOUT_LOOKUP_PATH);

  return (
    <div className="space-y-4">
      <PageTitle title="Channels without their lookup" />
      <p className="max-w-3xl text-sm text-text-muted">
        A channel whose sensor type declares a lookup, such as an interface status, is judged by
        that lookup: a value it calls an error turns the sensor Down. These channels do not hold the
        lookup their type declares, so their values are judged by nothing. Most lost it when they
        were cloned by an earlier release. Somebody may also have cleared one on purpose, so that a
        port nobody uses stays quiet, and nothing recorded tells the two apart, so none is filled in
        for you. Set the lookup listed here on the ones that should be judged: open the sensor, and
        in its channel table under <span className="font-medium">Judged by</span> choose the lookup
        marked as declared by its type, then <span className="font-medium">Set lookup</span>.
        Setting one needs write on the sensor. One that should stay quiet needs nothing.
      </p>

      <ReadState read={list} what="the channels without their lookup" />
      {list.status === 'ready' && (
        <Card>
          {list.data.items.length === 0 ? (
            <Empty because="Only sensors you can see are listed.">
              No channel you can see is without the lookup its type declares.
            </Empty>
          ) : (
            <>
              <p role="status" className="mb-3 text-sm text-text-muted">
                {summary(list.data.items.length, list.data.total)}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <caption className="sr-only">
                    Channels without the lookup their sensor type declares, with the sensor each
                    belongs to and the lookup declared
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Sensor
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Channel
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Declared lookup
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {list.data.items.map((one) => (
                      <tr key={`${String(one.sensorId)}:${one.key}`}>
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <Link
                            to={`/objects/${String(one.sensorId)}`}
                            className="text-accent hover:underline"
                          >
                            {one.sensorName}
                          </Link>{' '}
                          <span className="text-xs text-text-muted">{one.sensorType}</span>
                        </th>
                        <td className="py-2 pr-3">
                          {one.channelName}{' '}
                          <span className="font-mono text-xs text-text-muted">{one.key}</span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{one.declaredLookup}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {list.data.unanswered > 0 && (
            <p className="mt-3 text-sm text-text-muted">
              {list.data.unanswered === 1
                ? '1 sensor with a channel that has no lookup is not judged here: its type could not say what it declares for its parameters, or is not in this release.'
                : `${String(list.data.unanswered)} sensors with a channel that has no lookup are not judged here: their type could not say what it declares for their parameters, or is not in this release.`}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
