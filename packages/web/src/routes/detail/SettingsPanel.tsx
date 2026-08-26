import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { SettingView } from '../../api/types';
import { Empty } from '../../components/Panels';

/**
 * Every inheritable setting in effect, and where each value came from (`S-04`).
 *
 * **The source is the half that matters.** "60 seconds" is not the same fact as "60 seconds,
 * because the group two levels up says so", and an operator who changes the wrong object is what
 * happens when only the value is shown — they set it here, it appears to work, and the next
 * sensor added to that group behaves differently for reasons nobody can find.
 *
 * Grouped by prefix, because the keys already carry one and reading twenty flat rows to find the
 * scan settings is worse than reading three headings.
 *
 * Read-only. `U-08` generates the form from the schema and `U-09` adds the inherit/override
 * control, which is the write half of exactly this display.
 */
export function SettingsPanel({
  items,
  ancestors,
}: {
  items: readonly SettingView[];
  /**
   * Root first. Used only to name the object a value was inherited from — the API gives an id,
   * and "inherited from #7" makes an operator go and look up which object that is, on the page
   * that already knows.
   */
  ancestors: readonly { id: number; name: string }[] | null;
}): React.JSX.Element {
  if (items.length === 0) {
    return <Empty because="Nothing inheritable applies to this kind.">No settings.</Empty>;
  }

  const groups = new Map<string, SettingView[]>();
  for (const setting of items) {
    const prefix = setting.key.split('.')[0] ?? 'other';
    const held = groups.get(prefix);
    if (held === undefined) groups.set(prefix, [setting]);
    else held.push(setting);
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([prefix, settings]) => (
        <section key={prefix} className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">{prefix}</h3>
          <dl className="grid grid-cols-[minmax(9rem,14rem)_1fr] gap-x-4 gap-y-2 text-sm">
            {settings.map((setting) => (
              <Fragment key={setting.key}>
                <dt className="font-mono text-xs text-text-muted" title={setting.description}>
                  {setting.key.slice(prefix.length + 1)}
                </dt>
                <dd className="flex flex-wrap items-baseline gap-2 text-text">
                  <span className="font-mono">{format(setting.effective.value)}</span>
                  <Origin source={setting.effective.source} ancestors={ancestors} />
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * A setting value as an operator reads it.
 *
 * `null` is spelled out rather than printed as the word "null": for an inheritable setting it
 * means "nothing is set here or anywhere above", which is a state an operator acts on, not a
 * value. An empty string is quoted for the same reason — blank and unset look identical
 * otherwise, and only one of them is a choice somebody made.
 */
function format(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Where a value came from. Text, not a colour: this is the part an operator has to act on. */
function Origin({
  source,
  ancestors,
}: {
  source: SettingView['effective']['source'];
  ancestors: readonly { id: number; name: string }[] | null;
}): React.JSX.Element {
  if (source.kind === 'own') return <span className="text-xs text-text-muted">set here</span>;
  if (source.kind === 'default') {
    return <span className="text-xs text-text-muted">registry default</span>;
  }
  // An inheritable value can only come from an ancestor, so the breadcrumb already holds every
  // name this could need. Falling back to the id keeps it honest if that ever stops being true.
  const named = ancestors?.find((ancestor) => ancestor.id === source.objectId);
  return (
    <Link
      to={`/objects/${String(source.objectId)}?tab=settings`}
      className="text-xs text-accent hover:underline"
    >
      inherited from {named?.name ?? `#${String(source.objectId)}`}
    </Link>
  );
}
