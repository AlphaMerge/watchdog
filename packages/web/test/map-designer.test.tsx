import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { MapDesigner } from '../src/maps/MapDesigner';
import { CELL, readCanvas, type Canvas } from '../src/maps/canvas';
import { alertSaying, expectQuiet, speaking } from './support/refusal-region';

/**
 * The designer, driven the way `U-11` says it has to be drivable: from the keyboard (`G-03`).
 *
 * The geometry and the undo stack are asserted in `canvas-model.test.ts`. What is left here is
 * the glue — that a key press reaches the model at all, that the announcement says where the tile
 * went, and that a refused save does not take somebody's work with it.
 *
 * **Every position is asserted through the accessible name**, not through inline styles. A tile
 * whose `left` is right and whose label still says the old column is a tile a screen-reader user
 * cannot follow, and that is the half of this view most likely to rot.
 */

/**
 * Two gaps in jsdom, and the second one is why the drag case below is worth having.
 *
 * jsdom implements no `PointerEvent`, so `fireEvent.pointerDown(tile, { clientX: 100 })` builds a
 * bare `Event` and **every property the handler reads arrives `undefined`** — `button`, `clientX`,
 * `pointerId`. The designer's `begin` returns early on a non-primary button, so the drag silently
 * never started and the case passed through a code path it was not exercising. A `MouseEvent`
 * subclass is enough: it carries the coordinates, and `pointerId` is the only field it lacks.
 */
beforeAll(() => {
  if (typeof window.PointerEvent !== 'function') {
    class Pointer extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: Pointer });
  }

  // And no working pointer capture. Defined unconditionally rather than only when missing:
  // jsdom ships the method and throws from it, so a feature check passes and the drag still dies.
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: () => undefined,
  });
});

const CANVAS: Canvas = readCanvas({
  widgets: [
    { id: 'w1', kind: 'status', objectId: 7, title: 'Router', box: { x: 2, y: 2, w: 6, h: 4 } },
    { id: 'w2', kind: 'table', objectId: 8, title: 'Uplink', box: { x: 12, y: 2, w: 6, h: 4 } },
  ],
});

const HOME = 'Router, Status, column 3, row 3, 6 by 4';

function designer(save: (canvas: Canvas) => Promise<void> = () => Promise.resolve()): void {
  render(<MapDesigner initial={CANVAS} save={save} />);
}

/** Throws when no widget has this name, which is the assertion in every case below. */
function tileNamed(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function router(): HTMLElement {
  return screen.getByRole('button', { name: /^Router,/ });
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Save/ });
}

function undoButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Undo' });
}

describe('the designer canvas', () => {
  it('draws every widget where the document put it', () => {
    designer();
    expect(tileNamed(HOME)).toBeDefined();
    expect(tileNamed('Uplink, Channel table, column 13, row 3, 6 by 4')).toBeDefined();
  });

  it('moves the focused widget with an arrow key, and says where it went', async () => {
    designer();
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(tileNamed('Router, Status, column 4, row 3, 6 by 4')).toBeDefined();
    });
    expect(screen.getByRole('status').textContent).toBe('Router at column 4, row 3, 6 by 4');
  });

  it('resizes with shift and an arrow rather than moving', async () => {
    designer();
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => {
      expect(tileNamed('Router, Status, column 3, row 3, 7 by 4')).toBeDefined();
    });
  });

  it('removes the focused widget, and undo brings it back', async () => {
    designer();
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'Delete' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Router,/ })).toBeNull();
    });

    // Ctrl and Z from the canvas rather than from the tile — the tile it would have come from is
    // the one that was just deleted, which is exactly when somebody reaches for undo.
    fireEvent.keyDown(screen.getByRole('group', { name: 'Map canvas' }), {
      key: 'z',
      ctrlKey: true,
    });
    await waitFor(() => {
      expect(tileNamed(HOME)).toBeDefined();
    });
  });

  it('undoes with Cmd and Z as well, because a Mac says the same thing differently', async () => {
    designer();
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('row 4');
    });

    fireEvent.keyDown(tile, { key: 'z', metaKey: true });
    await waitFor(() => {
      expect(tileNamed(HOME)).toBeDefined();
    });
  });

  it('makes one undo step out of a whole drag', async () => {
    // The glue for the thing the model is careful about: many pointer moves, one entry.
    designer();
    const tile = router();
    fireEvent.pointerDown(tile, { button: 0, clientX: 100, clientY: 100 });
    for (let i = 1; i <= 4; i += 1) {
      fireEvent.pointerMove(tile, { clientX: 100 + CELL * i, clientY: 100 });
    }
    fireEvent.pointerUp(tile, { clientX: 100 + CELL * 4, clientY: 100 });

    await waitFor(() => {
      expect(tileNamed('Router, Status, column 7, row 3, 6 by 4')).toBeDefined();
    });

    fireEvent.keyDown(screen.getByRole('group', { name: 'Map canvas' }), {
      key: 'z',
      ctrlKey: true,
    });
    await waitFor(() => {
      expect(tileNamed(HOME)).toBeDefined();
    });

    // **And nothing left to undo, which is the half that makes this case mean anything.**
    // Recording every pointer move *also* leaves the tile at home after one Ctrl+Z, because the
    // entry pushed when the drag ends is the origin either way — so "one undo returns it" passes
    // against four entries as happily as against one. The empty stack is what tells them apart.
    expect(undoButton().disabled).toBe(true);
  });

  it('joins two widgets, lists the connection, and cuts it again', async () => {
    // **Connecting is a mode and it says so**: the button reads Cancel while it is armed, and the
    // second widget is chosen by activating it — a click or Enter, so the keyboard path is the
    // same path.
    designer();
    fireEvent.focus(router());
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^Uplink,/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disconnect Router to Uplink' })).toBeDefined();
    });
    // The list is the text alternative for a line no screen reader can read, and the place the
    // line is removed from. One list, both jobs.
    expect(screen.getByRole('heading', { name: 'Connections' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Router to Uplink' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
    });
  });

  it('abandons a half-drawn connection on Escape', async () => {
    designer();
    fireEvent.focus(router());
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.keyDown(screen.getByRole('group', { name: 'Map canvas' }), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined();
    });
    // And clicking the other widget after that connects nothing.
    fireEvent.click(screen.getByRole('button', { name: /^Uplink,/ }));
    expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
  });

  it('takes the line with the widget', async () => {
    designer();
    fireEvent.focus(router());
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(screen.getByRole('button', { name: /^Uplink,/ }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Connections' })).toBeDefined();
    });

    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'Delete' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Connections' })).toBeNull();
    });
  });

  it('has nothing to save until something changes', () => {
    designer();
    expect(saveButton().disabled).toBe(true);
  });

  it('saves the canvas as it now stands', async () => {
    const save = vi.fn<(canvas: Canvas) => Promise<void>>(() => Promise.resolve());
    designer(save);
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(saveButton().disabled).toBe(false);
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const sent = save.mock.calls[0]?.[0];
    expect(sent?.tiles[0]?.box).toEqual({ x: 3, y: 2, w: 6, h: 4 });
    await waitFor(() => {
      expect(saveButton().disabled).toBe(true);
    });
  });

  it('keeps the work when the core refuses the save', async () => {
    // **The one moment the afternoon exists only in this tab.** Rolling the canvas back to show a
    // tidy error would be precisely the loss `If-Match` was added to prevent.
    const save = vi.fn<(canvas: Canvas) => Promise<void>>(() =>
      // 412, as the core answers a stale `If-Match` since `L-06`.
      Promise.reject(new ApiError(412, 'MAP_CHANGED', 'map 4 has moved on', 'abc')),
    );
    designer(save);
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(saveButton().disabled).toBe(false);
    });
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('MAP_CHANGED');
    });
    expect(screen.getByText(/Somebody else saved this map/)).toBeDefined();
    expect(tileNamed('Router, Status, column 4, row 3, 6 by 4')).toBeDefined();
    expect(saveButton().disabled).toBe(false);
  });
});

/**
 * A refused save, announced (`U-54`): said through an `ErrorPanel` in a region that is in the tree
 * and empty before anything is saved, with what a `MAP_CHANGED` means said inside it; the next
 * save empties it as it starts, so the same words are said again; one accepted leaves it empty.
 */
describe('a refused save (U-54)', () => {
  it('is said in the region under the toolbar, again, and emptied by one accepted', async () => {
    const answers = [true, true, false];
    const save = vi.fn<(canvas: Canvas) => Promise<void>>(() =>
      answers.shift() === true
        ? Promise.reject(new ApiError(412, 'MAP_CHANGED', 'map 4 has moved on', 'abc'))
        : Promise.resolve(),
    );
    designer(save);
    const region = screen.getByRole('alert');
    expectQuiet(region, ['mt-3', 'empty:mt-0']);
    const tile = router();
    fireEvent.focus(tile);
    fireEvent.keyDown(tile, { key: 'ArrowRight' });
    const saved = async (): Promise<void> => {
      await waitFor(() => {
        expect(saveButton().disabled).toBe(false);
      });
      fireEvent.click(saveButton());
    };

    await saved();
    expect(await alertSaying('MAP_CHANGED')).toBe(region);
    expect(region.textContent).toMatch(/Somebody else saved this map/u);
    await saved();
    expect(region.matches(':empty')).toBe(true);
    expect(await alertSaying('MAP_CHANGED')).toBe(region);
    await saved();
    expect(region.matches(':empty')).toBe(true);
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(saveButton().disabled).toBe(true);
    });
    expect(speaking()).toEqual([]);
  });
});
