import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/client';
import type { SensorTypeSummary } from '../api/types';
import { Card, Empty } from '../components/Panels';
import { Combobox, type ComboboxOption } from '../components/Combobox';
import { PageTitle } from '../components/PageTitle';
import { WITHOUT_LOOKUP_PATH } from './channels-without-lookup';
import {
  matchRange,
  plural,
  searchTypes,
  suggest,
  type ParameterSummary,
  type SuggestionKind,
  type TypeMatch,
} from './sensor-types-model';
import { ReadState } from '../components/ReadRegion';

/** Stable empty catalogue — see the note where it is used. */
const NONE: readonly SensorTypeSummary[] = [];

/**
 * The catalogue, straight from `GET /sensor-types` — the same document `U-08` generates the
 * add-sensor form from. Showing the parameters here is a cheap way to see whether a type's
 * schema says what its author meant, long before there is a form to find out with.
 *
 * **Shut by default, because forty-three types are three hundred and twenty-two parameters.**
 * Every card open made the page a mile of tables with no way to see what types exist at all;
 * the useful default is the list of type names, one line each, with the schema a click away.
 *
 * **The search covers all three things this page holds** — type ids, categories and parameter
 * names — because "which types take a `verifyTls`?" is the question a catalogue is for, and it
 * cannot be answered by scrolling. A hit on a parameter opens its card on the way in: somebody
 * who searched for a parameter wants the row, not the card that happens to contain it.
 */
export function SensorTypesView(): React.JSX.Element {
  const types = useApi<{ items: SensorTypeSummary[] }>('/sensor-types');
  const [query, setQuery] = useState('');
  /**
   * Only the cards somebody has *decided* about, and which way.
   *
   * Not the set of open cards: what the search opens is derived from the search, so clearing it
   * shuts those again on its own. A set of open ids would have to be edited by an effect on
   * every keystroke, and thirteen cards opened by a search for `veri` would still be open —
   * with nothing on screen to say why — long after the search was gone.
   */
  const [decided, setDecided] = useState<ReadonlyMap<string, boolean>>(new Map());

  // `state.data` is one object for the life of a fetch, so this is referentially stable and the
  // memos below actually memoise; a fresh `[]` each render would rebuild the search every time.
  const catalogue: readonly SensorTypeSummary[] =
    types.status === 'ready' ? types.data.items : NONE;
  const matches = useMemo(() => searchTypes(catalogue, query), [catalogue, query]);
  const options = useMemo(() => toOptions(suggest(catalogue, query), query), [catalogue, query]);

  const isOpen = (match: TypeMatch): boolean =>
    decided.get(match.type.id) ?? match.matchedParameters.length > 0;
  const anyOpen = matches.some(isOpen);
  const allOpen = matches.every(isOpen);

  const toggle = (match: TypeMatch): void => {
    const wanted = !isOpen(match);
    setDecided((was) => new Map(was).set(match.type.id, wanted));
  };
  const setAll = (wanted: boolean): void => {
    setDecided((was) => {
      const next = new Map(was);
      for (const match of matches) next.set(match.type.id, wanted);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle title="Sensor types" />
        <div className="w-full sm:ml-auto sm:w-80">
          <Combobox
            id="sensor-type-search"
            label="Search sensor types"
            placeholder="Search types, categories, parameters"
            value={query}
            onChange={setQuery}
            onPick={(option) => {
              setQuery(option.value);
            }}
            options={options}
          />
        </div>
      </div>
      {/* Where a type's declarations meet channels that do not hold them (`P-308`). */}
      <p className="text-sm text-text-muted">
        <Link to={WITHOUT_LOOKUP_PATH} className="text-accent hover:underline">
          Channels without the lookup their type declares
        </Link>
      </p>

      <ReadState read={types} what="the catalogue" />

      {types.status === 'ready' &&
        (catalogue.length === 0 ? (
          <Card>
            <Empty because="P-05 shipped the contract and the registry. P-08 (Ping), P-09 (HTTP), P-10 (Port) and P-11 (DNS) are the first four types.">
              No sensor types are registered, so no sensor can be created.
            </Empty>
          </Card>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
              {/*
                Polite rather than silent: the list below changes as somebody types, and a
                keyboard or screen-reader user who cannot see it change has otherwise no signal
                that the search did anything — including the case that matters, no matches.
              */}
              <p role="status" aria-live="polite">
                {query.trim() === ''
                  ? `${plural(catalogue.length, 'type')} in the catalogue`
                  : `${plural(matches.length, 'type')} matching “${query.trim()}”`}
              </p>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAll(true);
                  }}
                  disabled={allOpen}
                  className="border border-control px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAll(false);
                  }}
                  disabled={!anyOpen}
                  className="border border-control px-2 py-1 text-xs text-text hover:bg-surface disabled:opacity-50"
                >
                  Collapse all
                </button>
              </div>
            </div>

            {matches.length === 0 ? (
              <Card>
                <Empty because="The search covers type ids, categories and parameter names — all of them substrings, so a partial name is enough.">
                  Nothing in the catalogue matches “{query.trim()}”.
                </Empty>
              </Card>
            ) : (
              <div className="space-y-2">
                {matches.map((match) => (
                  <TypeCard
                    key={match.type.id}
                    match={match}
                    query={query}
                    open={isOpen(match)}
                    onToggle={() => {
                      toggle(match);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        ))}
    </div>
  );
}

/** Enough of the type to decide whether to open it, and the schema once it is open. */
function TypeCard({
  match,
  query,
  open,
  onToggle,
}: {
  match: TypeMatch;
  query: string;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { type, parameters, matchedParameters } = match;
  const panelId = `sensor-type-${type.id}`;
  const matched = new Set(matchedParameters);

  return (
    <section className="border border-border bg-surface">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          // The same reason the suggestions carry one: with the matched substring marked, the
          // name computed from the content is "snmp .traf fic", and it would change as the
          // search was typed. What this button is called does not depend on the search.
          aria-label={`${type.id}, ${type.category}, ${type.costHint}, ${plural(
            parameters.length,
            'parameter',
          )}`}
          onClick={onToggle}
          // Wraps rather than truncates. The row's whole job is to say which type this is, and
          // at 320px — the width WCAG 1.4.10 asks about — a header that lets the meta hold its
          // width renders "d…" for `db.postgresql`, which names nothing.
          className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-left"
        >
          <span aria-hidden="true" className="w-3 shrink-0 text-text-muted">
            {open ? '▾' : '▸'}
          </span>
          <span className="min-w-0 break-all font-mono text-sm text-text">
            <Marked text={type.id} query={query} />
          </span>
          <span className="ml-auto text-xs text-text-muted">
            {type.category} · {type.costHint} · {plural(parameters.length, 'parameter')}
          </span>
        </button>
      </h2>

      {/*
        Why this card is in a filtered list, on the row itself — a card that matched on a
        parameter looks arbitrary next to its type id, which does not contain what was typed.
      */}
      {matchedParameters.length > 0 && (
        <p className="border-t border-border px-4 py-1.5 pl-10 text-xs text-text-muted">
          matches {matchedParameters.join(', ')}
        </p>
      )}

      <div id={panelId} hidden={!open} className="border-t border-border p-4">
        {parameters.length === 0 ? (
          <p className="text-sm text-text-muted">Takes no parameters.</p>
        ) : (
          // The table scrolls inside the card rather than pushing the page sideways: three
          // columns of identifiers do not fit 320px, and a page that scrolls horizontally
          // fails 1.4.10 for every other row on it too.
          <div className="overflow-x-auto">
            <ParameterTable parameters={parameters} matched={matched} query={query} />
          </div>
        )}
      </div>
    </section>
  );
}

function ParameterTable({
  parameters,
  matched,
  query,
}: {
  parameters: readonly ParameterSummary[];
  matched: ReadonlySet<string>;
  query: string;
}): React.JSX.Element {
  return (
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
        {parameters.map((parameter) => (
          <tr
            key={parameter.name}
            className={matched.has(parameter.name) ? 'bg-surface-muted' : ''}
          >
            <td className="py-2 font-mono text-text">
              <Marked text={parameter.name} query={query} />
              {parameter.required && <span className="ml-1 text-down-fg">*</span>}
              {parameter.writeOnly && (
                // The one annotation with teeth: it is why this value never comes back
                // from any read path (P-05).
                <span className="ml-2 border border-ack-border bg-ack-bg px-1.5 py-0.5 text-xs font-medium text-ack-fg">
                  write-only
                </span>
              )}
            </td>
            <td className="py-2 text-text-muted">{parameter.type}</td>
            <td className="py-2 font-mono text-text-muted">{parameter.defaultJson ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The matched substring, marked. Plain text when the query is elsewhere or empty. */
export function Marked({ text, query }: { text: string; query: string }): React.JSX.Element {
  const range = matchRange(text, query);
  if (range === null) return <>{text}</>;
  const [from, to] = range;
  return (
    <>
      {text.slice(0, from)}
      {/*
        The accent wash, not the warning fill it used to use. `bg-warning-bg text-warning-fg` is
        the colour this application spends on a sensor that is *in the warning state*, and
        wearing it to mean "your search matched here" says something about the type that is not
        true — worse now that the state palette is warm, because the difference between the
        ochre and the terracotta is no longer a difference in temperature. The accent already
        means "this is the thing you are after" everywhere else. 4.94:1 light, 5.53:1 dark.
      */}
      <mark className="bg-accent-wash px-0.5 text-accent">{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

const BADGE: Record<SuggestionKind, string> = {
  category: 'category',
  type: 'type',
  parameter: 'param',
};

function toOptions(
  suggestions: ReturnType<typeof suggest>,
  query: string,
): readonly ComboboxOption[] {
  return suggestions.map((suggestion) => ({
    value: suggestion.value,
    label: <Marked text={suggestion.value} query={query} />,
    badge: BADGE[suggestion.kind],
    detail: suggestion.detail,
  }));
}
