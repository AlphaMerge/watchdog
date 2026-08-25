import { useApi } from '../api/client';
import type { SensorTypeSummary } from '../api/types';
import { Card, Empty, ErrorPanel, Loading } from '../components/Panels';

/**
 * The catalogue, straight from `GET /sensor-types` — the same document `U-08` will generate the
 * add-sensor form from. Showing the parameters here is a cheap way to see whether a type's
 * schema says what its author meant, long before there is a form to find out with.
 */
export function SensorTypesView(): React.JSX.Element {
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-text">Sensor types</h1>

      {types.status === 'loading' && <Loading what="the catalogue" />}
      {types.status === 'error' && <ErrorPanel error={types.error} retry={types.reload} />}

      {types.status === 'ready' &&
        (types.data.items.length === 0 ? (
          <Card>
            <Empty because="P-05 shipped the contract and the registry. P-08 (Ping), P-09 (HTTP), P-10 (Port) and P-11 (DNS) are the first four types.">
              No sensor types are registered, so no sensor can be created.
            </Empty>
          </Card>
        ) : (
          <div className="space-y-4">
            {types.data.items.map((type) => (
              <TypeCard key={type.id} type={type} />
            ))}
          </div>
        ))}
    </div>
  );
}

function TypeCard({ type }: { type: SensorTypeSummary }): React.JSX.Element {
  const properties = (type.paramsSchema['properties'] ?? {}) as Record<
    string,
    { type?: string; writeOnly?: boolean; default?: unknown }
  >;
  const required = new Set((type.paramsSchema['required'] ?? []) as string[]);
  const names = Object.keys(properties);

  return (
    <Card
      title={<span className="font-mono">{type.id}</span>}
      actions={
        <span className="text-xs text-text-muted">
          {type.category} · {type.costHint}
        </span>
      }
    >
      {names.length === 0 ? (
        <p className="text-sm text-text-muted">Takes no parameters.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-text-muted">
              <th scope="col" className="pb-2 font-medium">
                Parameter
              </th>
              <th scope="col" className="pb-2 font-medium">
                Type
              </th>
              <th scope="col" className="pb-2 font-medium">
                Default
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {names.map((name) => {
              const property = properties[name];
              return (
                <tr key={name}>
                  <td className="py-2 font-mono text-text">
                    {name}
                    {required.has(name) && <span className="ml-1 text-down-fg">*</span>}
                    {property?.writeOnly === true && (
                      // The one annotation with teeth: it is why this value never comes back
                      // from any read path (P-05).
                      <span className="ml-2 rounded border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg">
                        write-only
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-text-muted">{property?.type ?? '—'}</td>
                  <td className="py-2 font-mono text-text-muted">
                    {property?.default === undefined ? '—' : JSON.stringify(property.default)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
