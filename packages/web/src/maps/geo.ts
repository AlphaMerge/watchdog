/**
 * Web Mercator, and which tiles cover a view (`G-08`, `ADR-004` Decision 5).
 *
 * **Ours rather than a mapping library's**, and this file is the argument for that: the projection
 * is two formulae, the inverse is two more, and "which tiles cover this rectangle" is a loop. A
 * library brings several hundred kilobytes, its own event model and its own theming for one
 * screen, and would still have to be taught `ADR-004` Decision 2 — that a map with no tile source
 * configured is a map, not an error.
 *
 * **Everything here is pure and in pixels.** The component pans and zooms by changing a `GeoView`;
 * nothing in this file knows what a DOM node is, which is what makes the awkward half — a latitude
 * that must not reach the pole, a tile grid that must not run off the world — testable by
 * arithmetic rather than by dragging something.
 */

/** Every raster tile scheme in use is 256 pixels square. */
export const TILE_SIZE = 256;

/**
 * How far the projection goes before it stops being finite.
 *
 * Mercator sends the poles to infinity, so every implementation cuts the world at the latitude
 * that makes it square: `atan(sinh(π))`, which is 85.051128…°. Clamping rather than refusing,
 * because a coordinate somebody typed at 89° is a place, and refusing to draw it is worse than
 * drawing it at the edge of the world it is nearly at.
 */
export const MAX_LATITUDE = 85.051_128_779_806_59;

/** Zoom 0 is one tile for the whole world; 19 is roughly a house. */
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 19;

export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Where a map opens: the centre of the view and how far in. Saved with the map (`ADR-004`). */
export interface GeoView {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const clampLatitude = (lat: number): number =>
  Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, lat));

/** Longitude wraps rather than clamping: 190° is 10° west, and somebody means it. */
export function wrapLongitude(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // -180 and 180 are the same meridian; the wrap above lands on -180, which is the left edge.
  return wrapped;
}

export const clampZoom = (zoom: number): number =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));

/** The whole world, in pixels, at this zoom. Doubles with every level. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** clampZoom(zoom);
}

/**
 * A coordinate as a pixel on the world at this zoom.
 *
 * The x half is a straight scaling of longitude. The y half is the Mercator part: latitude is
 * projected through `ln(tan(φ) + sec(φ))`, which is what makes a rhumb line straight and the
 * poles unreachable.
 */
export function project(point: LatLon, zoom: number): Point {
  const size = worldSize(zoom);
  const lat = (clampLatitude(point.lat) * Math.PI) / 180;
  const x = ((wrapLongitude(point.lon) + 180) / 360) * size;
  const y = ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * size;
  return { x, y };
}

/** The inverse, for "where on the ground did somebody click?" and for panning. */
export function unproject(point: Point, zoom: number): LatLon {
  const size = worldSize(zoom);
  const lon = (point.x / size) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (point.y / size);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Where a coordinate lands inside a viewport of this size, centred on this view. */
export function screenPosition(point: LatLon, view: GeoView, size: Viewport): Point {
  const centre = project({ lat: view.lat, lon: view.lon }, view.zoom);
  const target = project(point, view.zoom);
  return {
    x: target.x - centre.x + size.width / 2,
    y: target.y - centre.y + size.height / 2,
  };
}

/** And the inverse: what is under this pixel of the viewport. */
export function coordinateAt(pixel: Point, view: GeoView, size: Viewport): LatLon {
  const centre = project({ lat: view.lat, lon: view.lon }, view.zoom);
  return unproject(
    { x: centre.x + pixel.x - size.width / 2, y: centre.y + pixel.y - size.height / 2 },
    view.zoom,
  );
}

/** A view moved by a drag of this many pixels. Panning is done in pixels and stored as a place. */
export function pannedBy(view: GeoView, dx: number, dy: number, size: Viewport): GeoView {
  const moved = coordinateAt({ x: size.width / 2 - dx, y: size.height / 2 - dy }, view, size);
  return { lat: clampLatitude(moved.lat), lon: wrapLongitude(moved.lon), zoom: view.zoom };
}

export interface TilePlacement {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  /** Where this tile's top-left corner sits in the viewport. */
  readonly left: number;
  readonly top: number;
}

/**
 * Every tile needed to cover a viewport, with where to put each one.
 *
 * **Clamped to the world rather than wrapped.** Panning past the antimeridian shows empty canvas
 * instead of the other side of the world, and past the poles shows empty canvas instead of a
 * mirrored Antarctica. Wrapping is nicer and is a pile of modular arithmetic in the renderer as
 * well as here; nobody monitoring a network pans across the date line, and an empty edge is
 * honest about where the world stops.
 *
 * The count is bounded by the viewport: `ceil(width / 256) + 1` across, the same down. A caller
 * cannot ask for more tiles by choosing a coordinate.
 */
export function tilesFor(view: GeoView, size: Viewport): TilePlacement[] {
  const zoom = clampZoom(view.zoom);
  const across = 2 ** zoom;
  const centre = project({ lat: view.lat, lon: view.lon }, zoom);

  // The world pixel at the top-left corner of the viewport, and the tile it falls in.
  const originX = centre.x - size.width / 2;
  const originY = centre.y - size.height / 2;
  const firstX = Math.floor(originX / TILE_SIZE);
  const firstY = Math.floor(originY / TILE_SIZE);
  const lastX = Math.floor((originX + size.width) / TILE_SIZE);
  const lastY = Math.floor((originY + size.height) / TILE_SIZE);

  const tiles: TilePlacement[] = [];
  for (let y = firstY; y <= lastY; y += 1) {
    if (y < 0 || y >= across) continue;
    for (let x = firstX; x <= lastX; x += 1) {
      if (x < 0 || x >= across) continue;
      tiles.push({
        z: zoom,
        x,
        y,
        left: x * TILE_SIZE - originX,
        top: y * TILE_SIZE - originY,
      });
    }
  }
  return tiles;
}

/**
 * A tile's URL from an operator's template.
 *
 * **Refused unless it carries all three placeholders**, because a template missing one asks the
 * same tile of a provider for every position on the map — which looks like a broken renderer and
 * is a request pattern that gets an installation blocked.
 */
export function isTileTemplate(template: string): boolean {
  return (
    template.includes('{z}') &&
    template.includes('{x}') &&
    template.includes('{y}') &&
    /^https?:\/\//.test(template)
  );
}

export function tileUrl(template: string, tile: { z: number; x: number; y: number }): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/**
 * The origin a tile template loads from, for the content security policy (`ADR-004`).
 *
 * The application's `img-src` is `'self' data:`, so a configured provider is the first thing that
 * makes the policy depend on configuration. Returning the origin rather than the template keeps
 * the widening to exactly one host.
 */
export function tileOrigin(template: string): string | null {
  try {
    return new URL(template.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')).origin;
  } catch {
    return null;
  }
}
