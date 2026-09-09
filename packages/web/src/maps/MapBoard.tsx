import { useEffect, useMemo, useRef } from 'react';
import { useApi } from '../api/client';
import { useStateStream } from '../api/stream';
import type { LiveState, StateStreamOptions } from '../api/stream';
import type {
  HistorySeries,
  ResolvedConnector,
  ResolvedMap,
  ResolvedWidget,
  ResolvedWidgetData,
  SensorState,
} from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { groupByUnit } from '../charts/groups';
import { TimeSeriesChart } from '../charts/TimeSeriesChart';
import type { ChartSeries } from '../charts/time-series-model';
import { formatValue } from '../routes/detail/model';
import { CELL, COLUMNS, ROWS, connectorLine, rangeLabel } from './canvas';
import { historyPathFor } from './graph';
import { useClock } from './clock';
import { MapBackgroundImage } from './MapBackgroundImage';
import { backgroundUrl } from './background';

/**
 * A map as it is looked at, rather than as it is edited (`G-04`).
 *
 * **One socket and one clock for the whole canvas.** Every tile that shows a state reads it from
 * a single `useStateStream`, and every graph refreshes on a single interval — the alternative,
 * which is what a widget-shaped codebase drifts into, is twenty tiles each with a timer of their
 * own, a page that never settles, and twenty sockets to go with it. A tile here owns no schedule.
 *
 * **The series are fetched per graph tile and the resolved map is not.** One request brings back
 * every tile's identity, state and channels; the buckets behind a graph are a range that tile
 * alone chose, and folding those into the map request would mean sending a week of history for a
 * canvas somebody opened to look at three status icons.
 */

/** How often a graph re-reads its range. One timer, shared, and slower than a scan interval. */
const REFRESH_MS = 60_000;

export function MapBoard({
  view,
  stream,
}: {
  readonly view: ResolvedMap;
  /**
   * A socket to use instead of the browser's, which is how `StateStream` was already built to be
   * driven without a server. Only a test passes this; a real board opens its own.
   */
  readonly stream?: StateStreamOptions;
}): React.JSX.Element {
  // `null` is the whole tree: a map's widgets can name anything, so scoping the subscription to
  // a subtree would silently stop updating the tiles that pointed outside it.
  const { states } = useStateStream(null, stream);
  const tick = useClock(REFRESH_MS);

  return (
    <MapCanvas
      view={view}
      states={states}
      tick={tick}
      graphs="chart"
      backgroundSrc={backgroundUrl(view.map.id)}
    />
  );
}

/**
 * The drawing half, with nothing in it that needs a session (`G-06`).
 *
 * **Split out so the public page is the same canvas.** A shared map that rendered through a second
 * component would drift from this one the first time a widget kind was added, and the two would
 * disagree about what a map looks like — which is the one thing the person who made the link
 * cannot check.
 *
 * What the wrappers differ in is what they can *reach*: the authenticated board opens a state
 * stream and lets a graph fetch its history; `G-06`'s public page has neither, so it passes no
 * states and asks for the current readings instead of a chart.
 */
export function MapCanvas({
  view,
  states,
  tick,
  graphs,
  backgroundSrc,
}: {
  readonly view: { widgets: ResolvedWidget[]; connectors: ResolvedConnector[] };
  readonly states: ReadonlyMap<number, LiveState>;
  readonly tick: number;
  /** `values` is what a tile can draw with no access to the history route. */
  readonly graphs: 'chart' | 'values';
  readonly backgroundSrc: string | null;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto border border-border">
      <div
        className="relative bg-bg"
        style={{ width: COLUMNS * CELL, height: ROWS * CELL }}
        aria-label="Map"
        role="group"
      >
        {backgroundSrc !== null && <MapBackgroundImage src={backgroundSrc} />}

        <Connectors view={view} />

        {view.widgets.map((widget) => (
          <div
            key={widget.id}
            className="absolute overflow-hidden border border-border bg-surface"
            style={{
              left: widget.box.x * CELL,
              top: widget.box.y * CELL,
              width: widget.box.w * CELL,
              height: widget.box.h * CELL,
            }}
          >
            <Tile widget={widget} states={states} tick={tick} graphs={graphs} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({
  widget,
  states,
  tick,
  graphs,
}: {
  readonly widget: ResolvedWidget;
  readonly states: ReadonlyMap<number, LiveState>;
  readonly tick: number;
  readonly graphs: 'chart' | 'values';
}): React.JSX.Element {
  if (widget.state === 'invalid') {
    return (
      <Frame title={widget.title === '' ? 'Broken widget' : widget.title} broken>
        <p className="text-xs text-text-muted">{widget.problem}</p>
      </Frame>
    );
  }

  if (widget.state === 'unavailable') {
    return (
      <Frame title={widget.title === '' ? 'Unavailable' : widget.title} broken>
        {/*
          **The hole in the dashboard, on purpose.** `G-01` chose a document over a foreign key
          exactly so that deleting a sensor leaves a tile saying it is gone rather than a canvas
          that quietly stopped mentioning what failed. The reason is present only for somebody
          holding full access on the map — everyone else is told the tile cannot be drawn and
          not whether the object is deleted or merely invisible to them.
        */}
        <p className="text-xs text-text-muted">
          {widget.reason === 'object-deleted'
            ? 'The object this widget names has been deleted.'
            : widget.reason === 'not-visible'
              ? 'You may not see the object this widget names.'
              : 'This widget cannot be drawn.'}
        </p>
      </Frame>
    );
  }

  return <Drawn widget={widget} data={widget.data} states={states} tick={tick} graphs={graphs} />;
}

function Drawn({
  widget,
  data,
  states,
  tick,
  graphs,
}: {
  readonly widget: ResolvedWidget;
  readonly data: ResolvedWidgetData;
  readonly states: ReadonlyMap<number, LiveState>;
  readonly tick: number;
  readonly graphs: 'chart' | 'values';
}): React.JSX.Element {
  const title = widget.title === '' ? data.name : widget.title;

  if (data.kind === 'status') {
    // The stream's answer when it has one: the resolved map is a snapshot from when the request
    // was made, and this tile's whole job is to be current.
    const live = states.get(data.objectId);
    const state = (live?.state ?? data.sensorState) as SensorState;
    return (
      <Frame title={title}>
        <div className="flex items-center gap-2">
          <StatusBadge state={state} />
        </div>
        <p className="mt-1 truncate text-xs text-text-muted">{live?.message ?? data.message}</p>
      </Frame>
    );
  }

  if (data.kind === 'sensor-list') {
    return (
      <Frame title={title}>
        {data.sensors.length === 0 && <p className="text-xs text-text-muted">No sensors below.</p>}
        <ul className="space-y-0.5">
          {data.sensors.map((sensor) => (
            <li key={sensor.id} className="flex items-center gap-2 text-xs">
              <StatusBadge
                state={(states.get(sensor.id)?.state ?? sensor.sensorState) as SensorState}
                size="sm"
              />
              <span className="truncate text-text">{sensor.name}</span>
            </li>
          ))}
        </ul>
      </Frame>
    );
  }

  if (data.kind === 'table') {
    return (
      <Frame title={title}>
        <table className="w-full text-xs">
          <tbody>
            {data.channels.map((channel) => (
              <tr key={channel.key}>
                <td className="truncate pr-2 text-text-muted">{channel.name}</td>
                <td className="text-right tabular-nums text-text">
                  {/* A gap is a dash, never a zero: the sensor recorded nothing. */}
                  {channel.value === null ? '—' : formatValue(channel.value, channel.unit, null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Frame>
    );
  }

  if (graphs === 'values') {
    // **A shared map shows the readings, not the history**, and the reason is `ADR-002`'s fourth
    // consequence: a range query per graph tile is the one thing an unauthenticated caller could
    // use to make the core work, and the resolver already carries the current values.
    return (
      <Frame title={`${title} · now`}>
        <table className="w-full text-xs">
          <tbody>
            {data.channels.map((channel) => (
              <tr key={channel.key}>
                <td className="truncate pr-2 text-text-muted">{channel.name}</td>
                <td className="text-right tabular-nums text-text">
                  {channel.value === null ? '—' : formatValue(channel.value, channel.unit, null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Frame>
    );
  }

  return (
    <GraphTile
      title={title}
      sensorId={data.objectId}
      rangeMinutes={data.rangeMinutes}
      height={widget.box.h * CELL - 34}
      tick={tick}
    />
  );
}

function Frame({
  title,
  broken = false,
  children,
}: {
  readonly title: string;
  readonly broken?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`h-full px-2 py-1 ${broken ? 'border-l-2 border-l-down-fg' : ''}`}>
      <p className="ms-label truncate">{title}</p>
      <div className="mt-1 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * One sensor's history, at the size and range the author chose.
 *
 * **One chart, not one per unit.** The sensor page splits a sensor's channels into a chart per
 * unit, because a shared y-axis across units is the dual-axis lie (`U-05`). A tile has room for
 * one chart, so it draws the group the primary channel is in and names the others in its label —
 * that keeps the one-axis rule rather than bending it, and the sensor page is one click away for
 * the rest.
 */
function GraphTile({
  title,
  sensorId,
  rangeMinutes,
  height,
  tick,
}: {
  readonly title: string;
  readonly sensorId: number;
  readonly rangeMinutes: number;
  readonly height: number;
  readonly tick: number;
}): React.JSX.Element {
  // The tick is what moves this, so the path is stable between refreshes: a `new Date()` in the
  // render body would make a new path every render and refetch for ever.
  const path = useMemo(
    () => historyPathFor(sensorId, rangeMinutes, new Date()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the schedule, not a value
    [sensorId, rangeMinutes, tick],
  );
  const history = useApi<HistorySeries>(path);

  // The previous answer, kept across a refresh. A chart that disappears every minute and comes
  // back is a canvas nobody can read; dimming says "fetching" without taking the picture away.
  const held = useRef<HistorySeries | null>(null);
  useEffect(() => {
    if (history.status === 'ready') held.current = history.data;
  }, [history]);
  const showing = history.status === 'ready' ? history.data : held.current;

  const group = showing === null ? undefined : groupByUnit(showing.channels)[0];
  const series: ChartSeries[] =
    group === undefined
      ? []
      : group.series.map((entry) => ({
          label: entry.channel.name,
          slot: entry.slot,
          avg: entry.channel.avg,
          min: entry.channel.min,
          max: entry.channel.max,
        }));
  const times = useMemo(
    () => (showing === null ? [] : showing.buckets.map((at) => Date.parse(at) / 1000)),
    [showing],
  );
  const decimals = group?.series[0]?.channel.decimals ?? null;
  const unit = group?.unit ?? '';

  return (
    <div className="h-full px-2 py-1">
      <p className="ms-label truncate">
        {title} · {rangeLabel(rangeMinutes)}
      </p>
      {showing === null && <p className="text-xs text-text-muted">Loading…</p>}
      {showing !== null && series.length === 0 && (
        <p className="text-xs text-text-muted">This sensor has no channels to draw.</p>
      )}
      {series.length > 0 && (
        <div
          className={history.status === 'loading' ? 'opacity-60 transition-opacity' : undefined}
          aria-busy={history.status === 'loading'}
        >
          <TimeSeriesChart
            times={times}
            series={series}
            height={Math.max(60, height)}
            format={(value) => formatValue(value, unit, decimals)}
            label={`${title}, ${rangeLabel(rangeMinutes)}`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The lines, and the same lines as text (`G-05`).
 *
 * **Both, always.** The SVG is `aria-hidden` because a `<line>` has no name worth announcing, and
 * the visually-hidden list is what a screen reader actually reads — "Router to Switch". Rendering
 * only one of them would mean either a picture nobody can read or a list nobody can see.
 */
function Connectors({
  view,
}: {
  readonly view: { widgets: ResolvedWidget[]; connectors: ResolvedConnector[] };
}): React.JSX.Element | null {
  if (view.connectors.length === 0) return null;
  const boxes = new Map(view.widgets.map((widget) => [widget.id, widget]));
  const named = (id: string): string => {
    const widget = boxes.get(id);
    if (widget === undefined) return id;
    return widget.title === '' ? id : widget.title;
  };

  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        width={COLUMNS * CELL}
        height={ROWS * CELL}
      >
        {view.connectors.map((line) => {
          const from = boxes.get(line.from);
          const to = boxes.get(line.to);
          if (from === undefined || to === undefined) return null;
          const ends = connectorLine(from.box, to.box);
          return (
            <line
              key={line.id}
              x1={ends.x1}
              y1={ends.y1}
              x2={ends.x2}
              y2={ends.y2}
              stroke="var(--ms-control-border)"
              strokeWidth={2}
            />
          );
        })}
      </svg>
      <ul className="sr-only">
        {view.connectors.map((line) => (
          <li key={line.id}>
            {named(line.from)} to {named(line.to)}
          </li>
        ))}
      </ul>
    </>
  );
}
