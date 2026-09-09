import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedWidget } from '../src/api/types';
import { MapCanvas } from '../src/maps/MapBoard';
import { MapDesigner } from '../src/maps/MapDesigner';
import { CELL, COLUMNS, ROWS, readCanvas, writeLayout, type Canvas } from '../src/maps/canvas';
import { screenPosition } from '../src/maps/geo';

/**
 * A map of the world, in the same canvas as everything else (`G-08`, `ADR-004`).
 *
 * The projection is asserted by arithmetic in `geo.test.ts`. What is left here is what the
 * decisions promised: that a map with no tile source configured still draws, that a widget with a
 * coordinate is placed by it while one without keeps its box, and that the document round-trips.
 */

const SIZE = { width: COLUMNS * CELL, height: ROWS * CELL };
const BERLIN = { lat: 52.52, lon: 13.405 };
const HOME = { lat: 52.52, lon: 13.405, zoom: 6 };

function widget(over: Partial<ResolvedWidget> = {}): ResolvedWidget {
  return {
    id: 'w1',
    kind: 'status',
    box: { x: 2, y: 3, w: 6, h: 4 },
    title: 'Router',
    state: 'ok',
    data: {
      kind: 'status',
      objectId: 7,
      name: 'router-1',
      sensorState: 'up',
      message: '',
      since: '2026-09-09T10:00:00.000Z',
    },
    ...over,
  } as ResolvedWidget;
}

function board(props: {
  widgets: ResolvedWidget[];
  geo?: { lat: number; lon: number; zoom: number } | null;
  tiles?: { urlTemplate: string; attribution: string } | null;
}): HTMLElement {
  const { container } = render(
    <MapCanvas
      view={{ widgets: props.widgets, connectors: [] }}
      states={new Map()}
      tick={0}
      graphs="chart"
      backgroundSrc={null}
      geo={props.geo ?? null}
      tiles={props.tiles ?? null}
    />,
  );
  return container;
}

describe('a map with no tile source', () => {
  it('draws, which is the whole reason the feature ships', () => {
    // `ADR-004` Decision 2: an air-gapped installation gets a map without tiles rather than a map
    // that does not load. No tile images, no error, and the widgets are still there.
    const container = board({ widgets: [widget({ at: BERLIN })], geo: HOME, tiles: null });
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('Router')).toBeDefined();
  });

  it('refuses a template that would ask for the same tile everywhere', () => {
    // A missing placeholder is a broken picture and a request pattern that gets an installation
    // blocked by its provider, so it draws nothing rather than something wrong.
    const container = board({
      widgets: [],
      geo: HOME,
      tiles: { urlTemplate: 'https://tiles.example/{z}/{x}.png', attribution: 'Somebody' },
    });
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('a map with one', () => {
  const TILES = { urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png', attribution: '© Somebody' };

  it('draws the tiles that cover the canvas', () => {
    const container = board({ widgets: [], geo: HOME, tiles: TILES });
    const images = [...container.querySelectorAll('img')];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute('src')).toMatch(/^https:\/\/tiles\.example\/6\/\d+\/\d+\.png$/);
    }
  });

  it('draws the attribution the provider requires', () => {
    // Not optional: removing it is an operator breaking somebody's terms using our software.
    board({ widgets: [], geo: HOME, tiles: TILES });
    expect(screen.getByText('© Somebody')).toBeDefined();
  });

  it('places a pinned widget on the ground and an unpinned one on the grid', () => {
    // The second half is what makes one map enough: a legend has no place on the ground, so a
    // widget without a coordinate keeps its box even on a geographical map.
    const container = board({
      widgets: [widget({ id: 'pinned', at: BERLIN }), widget({ id: 'legend', title: 'Legend' })],
      geo: HOME,
      tiles: TILES,
    });

    // The widget wrappers are the positioned boxes the canvas draws each tile into.
    const boxes = [...container.querySelectorAll('div.absolute')];
    const pinned = boxes.find((node) => node.textContent.includes('Router'));
    const legend = boxes.find((node) => node.textContent.includes('Legend'));
    expect(pinned).toBeDefined();
    expect(legend).toBeDefined();

    // Berlin is the centre of this view, so its widget sits in the middle of the canvas less half
    // its own size — a coordinate marks a place rather than starting at one.
    const centre = screenPosition(BERLIN, HOME, SIZE);
    expect((pinned as HTMLElement).style.left).toBe(`${String(centre.x - (6 * CELL) / 2)}px`);
    expect((legend as HTMLElement).style.left).toBe(`${String(2 * CELL)}px`);
  });
});

describe('making a map geographical', () => {
  const EMPTY: Canvas = readCanvas({ widgets: [] });

  function designer(canvas: Canvas = EMPTY, tilesConfigured = true): Canvas[] {
    const saved: Canvas[] = [];
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
    render(
      <MapDesigner
        initial={canvas}
        tilesConfigured={tilesConfigured}
        save={(next) => {
          saved.push(next);
          return Promise.resolve();
        }}
      />,
    );
    return saved;
  }

  it('adds a home view to the document, and takes it away again', async () => {
    const saved = designer();
    const toggle = screen.getByLabelText(/Place widgets on a map of the world/);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByLabelText('Opens at latitude')).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(writeLayout(saved[0] ?? EMPTY).geo).toMatchObject({ zoom: 2, publicTiles: false });

    fireEvent.click(screen.getByLabelText(/Place widgets on a map of the world/));
    await waitFor(() => {
      expect(screen.queryByLabelText('Opens at latitude')).toBeNull();
    });
  });

  it("says when the installation has no tile source, because that fix is not the author's", () => {
    designer(EMPTY, false);
    fireEvent.click(screen.getByLabelText(/Place widgets on a map of the world/));
    expect(screen.getByText(/No tile source is configured/)).toBeDefined();
  });

  it('keeps public tiles off until somebody asks for them', () => {
    // `ADR-004` Decision 4: a stranger's browser fetching tiles tells the provider this
    // installation exists, and the person making a share link cannot see that happen.
    designer();
    fireEvent.click(screen.getByLabelText(/Place widgets on a map of the world/));
    const optIn = screen.getByLabelText(/Draw map tiles on public share links/);
    expect((optIn as HTMLInputElement).checked).toBe(false);
  });
});

describe('the document', () => {
  it('round-trips a geographical map', () => {
    const canvas = readCanvas({
      geo: { lat: 52.52, lon: 13.405, zoom: 6, publicTiles: true },
      widgets: [
        { id: 'w1', kind: 'status', objectId: 7, at: { lat: 52.5, lon: 13.4 } },
        { id: 'w2', kind: 'status', objectId: 8 },
      ],
    });
    expect(canvas.geo).toEqual({ lat: 52.52, lon: 13.405, zoom: 6, publicTiles: true });
    expect(canvas.tiles[0]?.at).toEqual({ lat: 52.5, lon: 13.4 });
    expect(canvas.tiles[1]?.at).toBe(null);
    expect(readCanvas(writeLayout(canvas))).toEqual(canvas);
  });

  it('refuses a coordinate that is not one, rather than clamping it somewhere real', () => {
    const canvas = readCanvas({
      geo: { lat: 200, lon: 0, zoom: 4 },
      widgets: [{ id: 'w1', kind: 'status', objectId: 7, at: { lat: 0, lon: -400 } }],
    });
    // 200° north is a typo. Clamping it would put the map at the pole and the widget in the
    // Pacific, both of which look deliberate.
    expect(canvas.geo).toBe(null);
    expect(canvas.tiles[0]?.at).toBe(null);
  });

  it('leaves `geo` out of a document that has none', () => {
    // A key holding null is a key the next reader has to decide about.
    expect(writeLayout(readCanvas({ widgets: [] })).geo).toBeUndefined();
  });
});
