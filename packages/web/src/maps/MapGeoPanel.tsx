import type { Canvas, MapGeo, Tile } from './canvas';
import { placeAt, setGeo } from './canvas';

/**
 * Making a map geographical, and pinning widgets to places (`G-08`, `ADR-004`).
 *
 * **A map is geographical because it says where it opens**, not because of a `kind` somebody chose
 * at creation. Turning it on adds a home view to the document; turning it off removes that and
 * leaves every widget where its box says, so nothing is lost by trying it.
 *
 * **The tiles are the operator's, not ours.** When none is configured the canvas draws the
 * background image instead, and this panel says so rather than leaving somebody to wonder why the
 * world is blank — `ADR-004` Decision 1 is a decision an operator has to know about, because the
 * fix is theirs.
 */
export function MapGeoPanel({
  canvas,
  selected,
  disabled = false,
  tilesConfigured,
  onChange,
}: {
  readonly canvas: Canvas;
  /** The widget a coordinate would be given to, if one is selected. */
  readonly selected: Tile | undefined;
  readonly disabled?: boolean;
  /** Whether this installation has a tile source at all (`ADR-004` Decision 1). */
  readonly tilesConfigured: boolean;
  readonly onChange: (canvas: Canvas, said: string) => void;
}): React.JSX.Element {
  const geo = canvas.geo;

  const edit = (next: Partial<MapGeo>): void => {
    if (geo === null) return;
    onChange(setGeo(canvas, { ...geo, ...next }), 'Map view changed');
  };

  return (
    <div className="space-y-3">
      <h3 className="ms-label">Geographical</h3>

      <label className="flex items-center gap-2 text-xs text-text-muted">
        <input
          type="checkbox"
          checked={geo !== null}
          disabled={disabled}
          onChange={(event) => {
            // Turning it off keeps every widget: a tile pinned to a place still has a box, and
            // that is the whole reason a widget may carry both (`ADR-004`).
            onChange(
              setGeo(
                canvas,
                event.target.checked ? { lat: 0, lon: 0, zoom: 2, publicTiles: false } : null,
              ),
              event.target.checked ? 'This map is now geographical' : 'Back to a plain canvas',
            );
          }}
        />
        Place widgets on a map of the world
      </label>

      {geo !== null && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Coordinate
              label="Opens at latitude"
              value={geo.lat}
              disabled={disabled}
              onChange={(lat) => {
                edit({ lat });
              }}
            />
            <Coordinate
              label="longitude"
              value={geo.lon}
              disabled={disabled}
              onChange={(lon) => {
                edit({ lon });
              }}
            />
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Zoom</span>
              <input
                type="number"
                min={0}
                max={19}
                value={geo.zoom}
                disabled={disabled}
                onChange={(event) => {
                  edit({ zoom: Number(event.target.value) });
                }}
                className="mt-1 w-20 border border-control bg-surface px-2 py-1 text-sm text-text"
              />
            </label>
          </div>

          <p className="text-xs text-text-muted">
            {tilesConfigured
              ? 'Where this map opens for everybody. Panning is local to a browser and is not saved.'
              : 'No tile source is configured for this installation, so this map draws its widgets over the background image instead of over a street map. An administrator sets one in the core configuration.'}
          </p>

          <label className="flex items-start gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={geo.publicTiles}
              disabled={disabled}
              onChange={(event) => {
                edit({ publicTiles: event.target.checked });
              }}
            />
            {/*
              `ADR-004` Decision 4, said where the decision is taken. The default is the quiet one
              because the consequence is invisible to the person making a share link.
            */}
            <span>
              Draw map tiles on public share links too. Everyone who opens a link then tells the
              tile provider that this installation exists and which places it watches.
            </span>
          </label>

          <div className="space-y-1">
            <h4 className="ms-label">Selected widget</h4>
            {selected === undefined && (
              <p className="text-xs text-text-muted">
                Choose a widget on the canvas to pin it to a place.
              </p>
            )}
            {selected !== undefined && (
              <div className="flex flex-wrap items-end gap-3">
                <Coordinate
                  label="Widget latitude"
                  value={selected.at?.lat ?? geo.lat}
                  disabled={disabled}
                  onChange={(lat) => {
                    onChange(
                      placeAt(canvas, selected.id, { lat, lon: selected.at?.lon ?? geo.lon }),
                      'Widget pinned',
                    );
                  }}
                />
                <Coordinate
                  label="longitude"
                  value={selected.at?.lon ?? geo.lon}
                  disabled={disabled}
                  onChange={(lon) => {
                    onChange(
                      placeAt(canvas, selected.id, { lat: selected.at?.lat ?? geo.lat, lon }),
                      'Widget pinned',
                    );
                  }}
                />
                <button
                  type="button"
                  disabled={disabled || selected.at === null}
                  onClick={() => {
                    onChange(placeAt(canvas, selected.id, null), 'Widget back on the grid');
                  }}
                  className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
                >
                  Unpin
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One coordinate field.
 *
 * **Kept as text while it is being typed.** A number input bound straight to state turns "5" into
 * a jump across the world before somebody has finished typing "51.5", and a minus sign alone is
 * not a number at all — so the value is only handed on when it parses.
 */
function Coordinate({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="text-xs text-text-muted">
      <span className="ms-label block">{label}</span>
      <input
        type="number"
        step="any"
        defaultValue={value}
        disabled={disabled}
        onBlur={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="mt-1 w-28 border border-control bg-surface px-2 py-1 text-sm text-text"
      />
    </label>
  );
}
