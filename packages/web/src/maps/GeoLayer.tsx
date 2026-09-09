import { useState } from 'react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  TILE_SIZE,
  clampZoom,
  isTileTemplate,
  pannedBy,
  tileUrl,
  tilesFor,
  type GeoView,
  type Viewport,
} from './geo';

/**
 * The tile layer, and what a map looks like without one (`G-08`, `ADR-004`).
 *
 * **With no template configured this renders nothing at all**, which is `ADR-004` Decision 2 and
 * the whole reason the feature is shippable: the widgets are drawn over the map's background image
 * instead, an air-gapped installation gets a working map, and nobody sees a grid of broken images
 * or an error where a map should be.
 *
 * **Attribution is not optional and is not removable.** Every tile service asks for it, and
 * removing it is an operator breaking somebody else's terms using our software — so it is drawn
 * whenever tiles are, from the string the operator configured beside the URL.
 *
 * **Panning is local and nothing persists it.** Where a map opens is the author's decision, saved
 * with the map; a viewer moving around is looking, not editing. A wall display comes back to the
 * same place after a reboot rather than to wherever somebody left it on Tuesday.
 */
export function GeoLayer({
  view,
  size,
  template,
  attribution,
  onView,
}: {
  readonly view: GeoView;
  readonly size: Viewport;
  /** Empty when no provider is configured, which is the default. */
  readonly template: string;
  readonly attribution: string;
  /** Called as the viewer pans or zooms. Absent on a surface that should not move. */
  readonly onView?: (view: GeoView) => void;
}): React.JSX.Element | null {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

  // A template missing a placeholder would ask for the same tile at every position — a broken
  // picture, and a request pattern that gets an installation blocked by its provider.
  if (!isTileTemplate(template)) return null;

  const tiles = tilesFor(view, size);

  return (
    <div
      className="absolute left-0 top-0 overflow-hidden"
      style={{ width: size.width, height: size.height, touchAction: 'none' }}
      onPointerDown={(event) => {
        if (onView === undefined || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (drag === null || onView === undefined) return;
        // Each move is applied from the *last* position rather than from the drag's origin,
        // because the view itself is what moved — the opposite of the widget drag, where the
        // origin is fixed and accumulating would drift.
        onView(pannedBy(view, event.clientX - drag.x, event.clientY - drag.y, size));
        setDrag({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={() => {
        setDrag(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
      }}
    >
      {tiles.map((tile) => (
        <img
          key={`${String(tile.z)}/${String(tile.x)}/${String(tile.y)}`}
          src={tileUrl(template, tile)}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute"
          style={{ left: tile.left, top: tile.top, width: TILE_SIZE, height: TILE_SIZE }}
        />
      ))}

      {attribution !== '' && (
        <p
          className="pointer-events-none absolute bottom-0 right-0 bg-surface/80 px-1 text-[10px] text-text-muted"
          // The credit the provider requires. Drawn over the tiles rather than beside them so it
          // cannot be scrolled away from the thing it credits.
        >
          {attribution}
        </p>
      )}
    </div>
  );
}

/**
 * Zoom in and out, from the keyboard as well as the mouse (`U-11`).
 *
 * Separate from the layer because a canvas that cannot be zoomed without a scroll wheel is the
 * same failure the designer avoided: two buttons are the whole of the keyboard interface, and
 * they are also what a touch screen gets.
 */
export function GeoZoom({
  view,
  onView,
}: {
  readonly view: GeoView;
  readonly onView: (view: GeoView) => void;
}): React.JSX.Element {
  const step = (by: number): void => {
    onView({ ...view, zoom: clampZoom(view.zoom + by) });
  };

  return (
    <div className="flex items-center gap-2">
      <span className="ms-label">Zoom</span>
      <button
        type="button"
        onClick={() => {
          step(-1);
        }}
        disabled={view.zoom <= MIN_ZOOM}
        className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
      >
        Out
      </button>
      <span className="text-xs tabular-nums text-text-muted">{view.zoom}</span>
      <button
        type="button"
        onClick={() => {
          step(1);
        }}
        disabled={view.zoom >= MAX_ZOOM}
        className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
      >
        In
      </button>
    </div>
  );
}
