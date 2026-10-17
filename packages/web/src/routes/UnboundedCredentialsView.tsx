import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { CredentialKindSummary, UnboundedCredential } from '../api/types';
import { PageTitle } from '../components/PageTitle';
import { Card, Empty } from '../components/Panels';
import { kindName } from './detail/credentials-model';
import { ReadState } from '../components/ReadRegion';

/**
 * The credential sets with no bounds (`U-21`): what Core Health's **Credential sets without
 * targets** counts, as a list to work through.
 *
 * **Only the sets on objects this reader can see.** The channel counts the installation's, so
 * for an account granted one branch the number there can be higher than the rows here, and the
 * page says so rather than leaving the two to look like a fault.
 *
 * Each row goes to its object's Credentials tab, which is where a set is given targets.
 */
export function UnboundedCredentialsView(): React.JSX.Element {
  const sets = useApi<{ items: UnboundedCredential[] }>('/credentials/unbounded');
  // For the kinds' names only. A core that cannot answer still has a list worth showing, so a
  // failure here falls back to the ids.
  const kinds = useApi<{ items: CredentialKindSummary[] }>('/credential-kinds');
  const catalogue = kinds.status === 'ready' ? kinds.data.items : [];

  return (
    <div className="space-y-4">
      <PageTitle title="Credential sets without bounds" />
      <p className="max-w-3xl text-sm text-text-muted">
        A set with no allowed targets, and for SSH no host keys, goes wherever somebody with write
        on the object it is stored on puts a device. So write on that object is trust with the set.
        Give a set allowed targets on its object’s Credentials tab and it leaves this list.
      </p>

      <ReadState read={sets} what="the sets without bounds" />
      {sets.status === 'ready' && (
        <Card>
          {sets.data.items.length === 0 ? (
            <Empty because="Core Health counts every set in the installation. A set on an object outside your view is counted there and not listed here.">
              No set you can see is without bounds.
            </Empty>
          ) : (
            <>
              <p role="status" className="mb-3 text-sm text-text-muted">
                {sets.data.items.length === 1
                  ? '1 set without bounds, among the objects you can see.'
                  : `${String(sets.data.items.length)} sets without bounds, among the objects you can see.`}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <caption className="sr-only">
                    Credential sets with no bounds, and the object each is stored on
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Stored on
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Kind
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        Last changed
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sets.data.items.map((set) => (
                      <tr key={`${String(set.objectId)}:${set.kind}`}>
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <Link
                            to={`/objects/${String(set.objectId)}?tab=credentials`}
                            className="text-accent hover:underline"
                          >
                            {set.objectName}
                          </Link>{' '}
                          <span className="text-xs text-text-muted">{set.objectKind}</span>
                        </th>
                        <td className="py-2 pr-3">{kindName(catalogue, set.kind)}</td>
                        <td className="py-2 pr-3">
                          <time
                            dateTime={set.updatedAt}
                            title={set.updatedAt}
                            className="font-mono text-xs text-text-muted"
                          >
                            {new Date(set.updatedAt).toLocaleString()}
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
