/**
 * The geographical half of a map's document (`G-08`, `ADR-004`).
 *
 * **A map is geographical because it says where it opens.** There is no `kind` on `map` and no
 * second designer: `ADR-004`'s second open question was answered by noticing that a geographical
 * map needs box-positioned widgets anyway — a legend, a status list, a note — so the tile layer is
 * a property of the map, exactly as `G-05`'s background is, and a widget with a coordinate is
 * placed by it while a widget without keeps its box.
 *
 * **The extent is per map, not per viewer.** Where a map opens is part of what its author
 * arranged; a wall display has to come back to the same place after a reboot rather than to
 * wherever somebody left it. Panning is local to a browser and nothing persists it.
 */

/** Zoom 0 is one tile for the whole world; 19 is roughly a house. */
const MAX_ZOOM = 19;

export interface GeoView {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
  /**
   * Whether a `G-06` share link may draw tiles (`ADR-004` Decision 4).
   *
   * **Off unless somebody says otherwise.** A tile layer is fetched by the *viewer's* browser from
   * a third party, so every stranger who opens a public link tells that provider the installation
   * exists and which coordinates it cares about — and with a keyed provider, hands over the key.
   * None of that is visible to the person who made the link.
   */
  readonly publicTiles: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The map's home view, or `null` when this map is not geographical.
 *
 * **A centre out of range is refused, not clamped** — the same rule `readCoordinate` applies to a
 * widget, and the same one the designer applies before it saves. Clamping a latitude of 200 would
 * open the map at the pole, which looks deliberate; and because the two readers have to agree
 * about what a document *is*, a layout the designer treats as a plain canvas must not come back
 * from the view route as a geographical one.
 *
 * Zoom is the exception, and stays clamped: it is a scale rather than a place, every renderer
 * clamps it to the tile scheme anyway, and a map that opens too far in is still that map.
 */
export function readGeoView(layout: unknown): GeoView | null {
  const raw = isRecord(layout) && isRecord(layout['geo']) ? layout['geo'] : null;
  if (raw === null) return null;

  // A geo block without a centre is not a view. Absent rather than defaulted to null island,
  // because putting an unconfigured map in the Gulf of Guinea is a bug people have shipped.
  const centre = readCoordinate(raw);
  if (centre === null) return null;

  const zoom = finite(raw['zoom']) ?? 3;
  return {
    lat: centre.lat,
    lon: centre.lon,
    zoom: Math.min(MAX_ZOOM, Math.max(0, Math.round(zoom))),
    publicTiles: raw['publicTiles'] === true,
  };
}

/** A widget's own coordinate, or `null` when it is positioned by its box. */
export function readCoordinate(raw: unknown): { lat: number; lon: number } | null {
  if (!isRecord(raw)) return null;
  const lat = finite(raw['lat']);
  const lon = finite(raw['lon']);
  if (lat === null || lon === null) return null;
  // Out of range is a typo rather than a place: -400 is not a longitude anybody meant, and
  // clamping it would put a widget somewhere real and wrong.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}
