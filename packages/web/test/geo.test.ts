import { describe, expect, it } from 'vitest';
import {
  MAX_LATITUDE,
  MAX_ZOOM,
  TILE_SIZE,
  clampLatitude,
  clampZoom,
  coordinateAt,
  isTileTemplate,
  pannedBy,
  pannedBy as pan,
  project,
  screenPosition,
  tileOrigin,
  tileUrl,
  tilesFor,
  unproject,
  worldSize,
  wrapLongitude,
  type GeoView,
} from '../src/maps/geo';

/**
 * Web Mercator, by arithmetic (`G-08`, `ADR-004` Decision 5).
 *
 * **Properties rather than magic numbers.** A test asserting that Berlin is tile (1100, 671) at
 * zoom 11 proves that whoever wrote the test and whoever wrote the code made the same arithmetic
 * mistake. What is checked here are the things the projection has to satisfy whatever the
 * formulae are: the round trip, the corners of the world, the direction each axis runs, and that
 * the tile grid covers the viewport and never leaves the world.
 */

const view = (lat: number, lon: number, zoom: number): GeoView => ({ lat, lon, zoom });
const SCREEN = { width: 800, height: 600 };

describe('the projection', () => {
  it('puts null island in the middle of the world', () => {
    for (const zoom of [0, 1, 5, 12, MAX_ZOOM]) {
      const middle = worldSize(zoom) / 2;
      const point = project({ lat: 0, lon: 0 }, zoom);
      expect(point.x).toBeCloseTo(middle, 6);
      expect(point.y).toBeCloseTo(middle, 6);
    }
  });

  it('puts the meridians at the edges', () => {
    expect(project({ lat: 0, lon: -180 }, 3).x).toBeCloseTo(0, 6);
    // 180 wraps to the same meridian as -180, which is the left edge — the world does not have a
    // right edge you can name, and pretending it does is how a tile grid ends up one column wide.
    expect(project({ lat: 0, lon: 180 }, 3).x).toBeCloseTo(0, 6);
    expect(project({ lat: 0, lon: 179.999 }, 3).x).toBeGreaterThan(worldSize(3) * 0.999);
  });

  it('runs x east and y south', () => {
    const west = project({ lat: 0, lon: -10 }, 6);
    const east = project({ lat: 0, lon: 10 }, 6);
    const north = project({ lat: 40, lon: 0 }, 6);
    const south = project({ lat: -40, lon: 0 }, 6);
    expect(east.x).toBeGreaterThan(west.x);
    // Screen coordinates: y grows downwards, so the northern point has the smaller y.
    expect(north.y).toBeLessThan(south.y);
  });

  it('doubles the world with every zoom level', () => {
    expect(worldSize(0)).toBe(TILE_SIZE);
    expect(worldSize(3)).toBe(TILE_SIZE * 8);
    expect(worldSize(1) * 2).toBe(worldSize(2));
  });

  it('round-trips a coordinate through the projection', () => {
    const places = [
      { lat: 0, lon: 0 },
      { lat: 52.52, lon: 13.405 },
      { lat: -33.87, lon: 151.21 },
      { lat: 64.13, lon: -21.9 },
      { lat: -54.8, lon: -68.3 },
    ];
    for (const place of places) {
      for (const zoom of [0, 4, 11, 19]) {
        const back = unproject(project(place, zoom), zoom);
        // A pixel at zoom 0 is a whole continent, so the tolerance has to follow the zoom.
        const tolerance = 180 / 2 ** zoom / 100;
        expect(Math.abs(back.lat - place.lat)).toBeLessThan(tolerance + 0.0001);
        expect(Math.abs(back.lon - place.lon)).toBeLessThan(tolerance + 0.0001);
      }
    }
  });

  it('stops at the latitude where Mercator stops being finite', () => {
    // The poles project to infinity. Clamping rather than refusing: 89° is a place, and drawing
    // it at the edge of the world beats not drawing it.
    expect(clampLatitude(90)).toBe(MAX_LATITUDE);
    expect(clampLatitude(-90)).toBe(-MAX_LATITUDE);
    expect(Number.isFinite(project({ lat: 90, lon: 0 }, 4).y)).toBe(true);
    expect(project({ lat: 90, lon: 0 }, 4).y).toBeCloseTo(0, 6);
  });

  it('wraps a longitude rather than clamping it', () => {
    // 190° east is 170° west, and somebody typing it means that rather than "the edge".
    expect(wrapLongitude(190)).toBeCloseTo(-170, 9);
    expect(wrapLongitude(-190)).toBeCloseTo(170, 9);
    expect(wrapLongitude(13.4)).toBeCloseTo(13.4, 9);
  });

  it('keeps the zoom whole and inside the scheme', () => {
    expect(clampZoom(-3)).toBe(0);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(4.6)).toBe(5);
  });
});

describe('the viewport', () => {
  it("puts the view's own centre in the middle of the screen", () => {
    const where = screenPosition({ lat: 52.52, lon: 13.405 }, view(52.52, 13.405, 10), SCREEN);
    expect(where.x).toBeCloseTo(SCREEN.width / 2, 6);
    expect(where.y).toBeCloseTo(SCREEN.height / 2, 6);
  });

  it('round-trips a pixel back to the ground', () => {
    const here = view(48.85, 2.35, 12);
    const pixel = { x: 137, y: 401 };
    const back = screenPosition(coordinateAt(pixel, here, SCREEN), here, SCREEN);
    expect(back.x).toBeCloseTo(pixel.x, 6);
    expect(back.y).toBeCloseTo(pixel.y, 6);
  });

  it('moves the ground with the drag, not against it', () => {
    // Dragging the map to the right shows what was to the west, so the centre moves west.
    const before = view(0, 0, 8);
    const after = pan(before, 100, 0, SCREEN);
    expect(after.lon).toBeLessThan(before.lon);
    expect(pannedBy(before, 0, 100, SCREEN).lat).toBeGreaterThan(before.lat);
  });

  it('will not pan past the pole', () => {
    const after = pan(view(80, 0, 3), 0, 100_000, SCREEN);
    expect(after.lat).toBeLessThanOrEqual(MAX_LATITUDE);
    expect(Number.isFinite(after.lat)).toBe(true);
  });
});

describe('the tile grid', () => {
  it('covers the viewport', () => {
    const here = view(52.52, 13.405, 11);
    const tiles = tilesFor(here, SCREEN);
    expect(tiles.length).toBeGreaterThan(0);

    // Every corner of the screen has to land on one of the tiles that came back, or the map has
    // a hole in it exactly where somebody is looking.
    const corners = [
      { x: 0, y: 0 },
      { x: SCREEN.width - 1, y: 0 },
      { x: 0, y: SCREEN.height - 1 },
      { x: SCREEN.width - 1, y: SCREEN.height - 1 },
    ];
    for (const corner of corners) {
      const covering = tiles.some(
        (tile) =>
          corner.x >= tile.left &&
          corner.x < tile.left + TILE_SIZE &&
          corner.y >= tile.top &&
          corner.y < tile.top + TILE_SIZE,
      );
      expect(covering).toBe(true);
    }
  });

  it('asks for no more tiles than the viewport needs', () => {
    // A caller cannot make this expensive by choosing a coordinate: the count follows the
    // screen, not the place.
    const most =
      (Math.ceil(SCREEN.width / TILE_SIZE) + 1) * (Math.ceil(SCREEN.height / TILE_SIZE) + 1);
    for (const zoom of [4, 8, 14, 19]) {
      expect(tilesFor(view(41.9, 12.5, zoom), SCREEN).length).toBeLessThanOrEqual(most);
    }
  });

  it('never asks for a tile outside the world', () => {
    // Zoom 2 is a 4×4 world, and a viewport is bigger than it — so most of the screen is off the
    // map and the grid has to say so by leaving it empty rather than by asking for tile -1.
    const tiles = tilesFor(view(0, 0, 2), { width: 2000, height: 2000 });
    const across = 2 ** 2;
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(across);
      expect(tile.y).toBeLessThan(across);
    }
    expect(tiles).toHaveLength(across * across);
  });

  it('has exactly one tile at zoom 0', () => {
    const tiles = tilesFor(view(0, 0, 0), SCREEN);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ z: 0, x: 0, y: 0 });
  });

  it('places each tile where its own top-left corner belongs', () => {
    const tiles = tilesFor(view(0, 0, 3), SCREEN);
    // Neighbours are exactly one tile apart, which is the property that matters: a grid whose
    // spacing drifts is a map with seams in it.
    const row = tiles.filter((tile) => tile.y === tiles[0]?.y).sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i += 1) {
      expect((row[i]?.left ?? 0) - (row[i - 1]?.left ?? 0)).toBeCloseTo(TILE_SIZE, 6);
    }
  });
});

describe("an operator's tile template", () => {
  it('needs all three placeholders and a scheme', () => {
    // A template missing one asks for the same tile at every position, which looks like a broken
    // renderer and is a request pattern that gets an installation blocked.
    expect(isTileTemplate('https://tiles.example/{z}/{x}/{y}.png')).toBe(true);
    expect(isTileTemplate('https://tiles.example/{z}/{x}.png')).toBe(false);
    expect(isTileTemplate('tiles.example/{z}/{x}/{y}.png')).toBe(false);
    expect(isTileTemplate('')).toBe(false);
  });

  it('fills in the placeholders', () => {
    expect(tileUrl('https://t.example/{z}/{x}/{y}.png', { z: 4, x: 8, y: 5 })).toBe(
      'https://t.example/4/8/5.png',
    );
  });

  it('names the one origin the content policy has to allow', () => {
    // `img-src` is `'self' data:` today, and a configured provider is the first thing that makes
    // the policy depend on configuration. One host, not a template.
    expect(tileOrigin('https://tiles.example:8443/a/{z}/{x}/{y}.png')).toBe(
      'https://tiles.example:8443',
    );
    expect(tileOrigin('not a url')).toBe(null);
  });
});
