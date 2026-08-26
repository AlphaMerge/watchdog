import { Link } from 'react-router-dom';
import { useApi } from '../../api/client';
import type { TriggerView } from '../../api/types';
import { Empty, ErrorPanel, Loading } from '../../components/Panels';

interface TriggersResponse {
  objectId: number;
  items: TriggerView[];
}

/**
 * What would notify anybody about this object (`N-01`, `N-16`).
 *
 * **Inherited triggers accumulate; they do not displace.** This is the one place in the system
 * where inheritance does not mean "nearest wins": a trigger on the root and a trigger on the
 * device both fire, whereas an inherited *setting* is replaced by a nearer one. A UI that showed
 * only the nearest — or that greyed the inherited ones out the way an inherited setting is
 * greyed — would be describing the wrong mechanism, and the operator would conclude the root
 * trigger had been overridden when it is about to page them.
 *
 * Each row names the object it is defined on, because that is the only place it can be edited or
 * removed, and links there. `U-10` builds the editor.
 */
export function TriggersPanel({
  objectId,
  inheritsTriggers,
}: {
  objectId: number;
  /** `N-16`'s switch. When it is off, nothing above this object reaches it. */
  inheritsTriggers: boolean;
}): React.JSX.Element {
  const triggers = useApi<TriggersResponse>(`/objects/${String(objectId)}/triggers`);

  if (triggers.status === 'loading') return <Loading what="triggers" />;
  if (triggers.status === 'error') {
    return <ErrorPanel error={triggers.error} retry={triggers.reload} />;
  }

  const items = triggers.data.items;
  const own = items.filter((trigger) => !trigger.inherited);
  const inherited = items.filter((trigger) => trigger.inherited);

  return (
    <div className="space-y-4">
      {!inheritsTriggers && (
        <p className="rounded border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">
          This object does not inherit triggers. Nothing defined above it applies here, or to
          anything beneath it.
        </p>
      )}

      {items.length === 0 ? (
        <Empty because="Without one, a state change here notifies nobody.">
          No triggers are in effect.
        </Empty>
      ) : (
        <>
          <Group
            title="Defined here"
            triggers={own}
            empty="None. Every trigger in effect comes from an ancestor."
          />
          <Group
            title="Inherited"
            triggers={inherited}
            empty="None. Only the triggers defined here apply."
            note="An inherited trigger fires as well as the ones defined here, not instead of them."
          />
        </>
      )}
    </div>
  );
}

function Group({
  title,
  triggers,
  empty,
  note,
}: {
  title: string;
  triggers: readonly TriggerView[];
  empty: string;
  note?: string;
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{title}</h3>
      {note !== undefined && triggers.length > 0 && (
        <p className="text-xs text-text-muted">{note}</p>
      )}
      {triggers.length === 0 ? (
        <p className="text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {triggers.map((trigger) => (
            <li key={trigger.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              <span className="text-sm font-medium text-text">{trigger.kindName}</span>
              <span className="text-sm text-text-muted">{trigger.summary}</span>
              {!trigger.enabled && (
                <span
                  className="rounded border border-border px-1.5 py-0.5 text-xs text-text-muted"
                  title="Configured, but it will not fire"
                >
                  disabled
                </span>
              )}
              {trigger.inherited && (
                <Link
                  to={`/objects/${String(trigger.definedOn.objectId)}?tab=triggers`}
                  className="ml-auto text-xs text-accent hover:underline"
                >
                  from {trigger.definedOn.name}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
