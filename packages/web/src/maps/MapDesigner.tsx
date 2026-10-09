import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { RefusalPanel } from '../components/Panels';
import { ObjectPicker } from './ObjectPicker';
import { MapBackgroundControl } from './MapBackgroundControl';
import { MapGeoPanel } from './MapGeoPanel';
import { MapBackgroundImage } from './MapBackgroundImage';
import { backgroundUrl } from './background';
import { ConnectorLayer } from './ConnectorLayer';
import {
  CELL,
  COLUMNS,
  DEFAULT_RANGE_MINUTES,
  KIND_LABELS,
  MAX_HTML,
  OBJECT_KINDS,
  RANGES,
  ROWS,
  WIDGET_KINDS,
  addTile,
  canRedo,
  connect,
  disconnect,
  canUndo,
  canvasCommand,
  change,
  describeBox,
  draft,
  firstFreeBox,
  gestureBox,
  keepSelection,
  moveTile,
  nextTileId,
  placeTile,
  record,
  redo,
  removeTile,
  resizeTile,
  retimeTile,
  rewriteHtml,
  sameCanvas,
  rangeLabel,
  timeline,
  tileById,
  undo,
  type Box,
  type Canvas,
  type Gesture,
  type Tile,
  type WidgetKind,
} from './canvas';

/**
 * The designer canvas (`G-03`).
 *
 * **Every pointer gesture has a key, because 2.1.1 has no exception for canvases.** Drag, resize
 * and delete are all reachable from the keyboard — Tab reaches a tile, arrows move it, Shift and
 * an arrow resizes it, Delete removes it, Ctrl or Cmd with Z steps back. `U-11` found the tree
 * claiming a keyboard interface it did not have; a designer that can only be driven with a mouse
 * is the same failure with a bigger surface.
 *
 * **A tab stop per tile, deliberately, and against `U-11`'s own lesson.** The tree's 15,000 stops
 * were on a *navigation* surface where Tab was a wrong turn; here every tile is a thing being
 * edited, Tab is how a keyboard reaches the one it wants, and the ceiling is 200. A roving tab
 * stop would need arrow keys to change the selection — and arrows are how a tile moves.
 *
 * **What the toolbar does, the keyboard does, and both go through `canvasCommand`.** One decision
 * table rather than two, so an Undo button and Ctrl+Z cannot drift apart.
 */

export interface MapDesignerProps {
  /** Which map this is, for the background upload. Absent in tests that only drive the canvas. */
  readonly mapId?: number;
  /** Whether this installation has a tile source at all (`G-08`, `ADR-004` Decision 1). */
  readonly tilesConfigured?: boolean;
  readonly initial: Canvas;
  /** Saves, and answers with the version to send with the next one. Rejects with an `ApiError`. */
  readonly save: (canvas: Canvas) => Promise<void>;
  /** Read-only until somebody makes an edit that the core then refuses (see the note on `403`). */
  readonly disabled?: boolean;
}

export function MapDesigner({
  mapId,
  tilesConfigured = false,
  initial,
  save,
  disabled = false,
}: MapDesignerProps): React.JSX.Element {
  const [line, setLine] = useState(() => timeline(initial));
  const [selected, setSelected] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [kind, setKind] = useState<WidgetKind>('status');
  const [target, setTarget] = useState<{ id: number; name: string } | null>(null);
  const [saved, setSaved] = useState<Canvas>(initial);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  /**
   * What the live region is saying.
   *
   * **Repeating the same sentence does not re-announce it**, and that is the right answer here:
   * the message carries the position, so an identical one means the tile did not move — arrowing
   * into the edge of the canvas, usually. Silence is what "nothing happened" sounds like.
   */
  const [said, setSaid] = useState('');
  /**
   * The tile a connector is being drawn from, if one is.
   *
   * **A mode, and it says so on screen.** The alternative — drag from one tile to another — has no
   * keyboard equivalent that is not a mode anyway, and a hidden mode is how somebody ends up
   * connecting two tiles they meant to select.
   */
  const [connecting, setConnecting] = useState<string | null>(null);
  /** Bumped after a background change, so the stable image URL is re-requested this once. */
  const [backgroundNonce, setBackgroundNonce] = useState(0);

  /** Where the drag has got to. Read on pointer-up, which is a frame ahead of the last render. */
  const dragged = useRef<Box | null>(null);
  const canvas = line.present;
  const dirty = !sameCanvas(canvas, saved);

  const announce = useCallback((text: string): void => {
    setSaid(text);
  }, []);

  // The selection has to survive the canvas changing underneath it: undoing an addition leaves
  // it naming a tile that is gone, and every toolbar button would then silently do nothing.
  useEffect(() => {
    setSelected((was) => keepSelection(canvas, was));
    setConnecting((was) => keepSelection(canvas, was));
  }, [canvas]);

  const apply = useCallback(
    (next: Canvas, say: string): void => {
      setLine((was) => change(was, next));
      announce(say);
    },
    [announce],
  );

  const nameOf = (tile: Tile): string => {
    if (tile.title !== '') return tile.title;
    return tile.objectId === null
      ? KIND_LABELS[tile.kind]
      : `${KIND_LABELS[tile.kind]} of #${String(tile.objectId)}`;
  };

  /* ------------------------------------------------------------ the toolbar */

  /** A custom HTML tile names no object, so the picker is not part of adding one (`G-07`). */
  const needsObject = OBJECT_KINDS.has(kind);

  const add = (): void => {
    if (needsObject && target === null) return;
    const id = nextTileId(canvas);
    const named = needsObject && target !== null;
    const tile: Tile = {
      id,
      kind,
      objectId: named ? target.id : null,
      title: named ? target.name : KIND_LABELS[kind],
      rangeMinutes: DEFAULT_RANGE_MINUTES,
      html: '',
      // On the grid until somebody pins it: a new tile on a geographical map lands where there is
      // room, which is somewhere the author can see, rather than at a coordinate they did not
      // choose.
      at: null,
      box: firstFreeBox(canvas),
    };
    const next = addTile(canvas, tile);
    if (next === canvas) {
      announce('This map is full — 200 widgets is the most the core will draw.');
      return;
    }
    apply(next, `${tile.title} added at ${describeBox(tile.box)}`);
    setSelected(id);
  };

  const remove = (id: string): void => {
    const tile = tileById(canvas, id);
    apply(removeTile(canvas, id), `${tile === undefined ? 'Widget' : nameOf(tile)} removed`);
  };

  const stepBack = (): void => {
    if (!canUndo(line)) return;
    setLine(undo);
    announce('Undone');
  };

  const stepForward = (): void => {
    if (!canRedo(line)) return;
    setLine(redo);
    announce('Redone');
  };

  /* ------------------------------------------------------------- the keyboard */

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const command = canvasCommand(event, selected !== null);
    if (command.kind === 'none') return;
    if (disabled && command.kind !== 'cancel') return;
    event.preventDefault();

    // Escape during a drag puts the tile back where it was picked up — the one gesture a pointer
    // has no button for, and the reason a half-finished drag is not a trap.
    if (command.kind === 'cancel') {
      if (connecting !== null) {
        setConnecting(null);
        announce('Connection abandoned');
        return;
      }
      if (gesture !== null) {
        setLine((was) => draft(was, gesture.before));
        setGesture(null);
        announce('Move abandoned');
      }
      return;
    }
    if (command.kind === 'undo') {
      stepBack();
      return;
    }
    if (command.kind === 'redo') {
      stepForward();
      return;
    }
    if (selected === null) return;
    if (command.kind === 'delete') {
      remove(selected);
      return;
    }

    const next =
      command.kind === 'move'
        ? moveTile(canvas, selected, command.dx, command.dy)
        : resizeTile(canvas, selected, command.dw, command.dh);
    const tile = tileById(next, selected);
    if (tile === undefined || next === canvas) return;
    apply(next, `${nameOf(tile)} at ${describeBox(tile.box)}`);
  };

  /* -------------------------------------------------------------- the pointer */

  const begin = (event: React.PointerEvent, tile: Tile, mode: 'move' | 'resize'): void => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(tile.id);
    setGesture({
      id: tile.id,
      mode,
      origin: tile.box,
      from: { x: event.clientX, y: event.clientY },
      before: canvas,
    });
  };

  const during = (event: React.PointerEvent): void => {
    if (gesture === null) return;
    const box = gestureBox(gesture, { x: event.clientX, y: event.clientY });
    dragged.current = box;
    setLine((was) => draft(was, placeTile(was.present, gesture.id, box)));
  };

  const end = (): void => {
    if (gesture === null) return;
    setLine((was) => record(was, gesture.before));
    const tile = tileById(canvas, gesture.id);
    // The box from the last pointer move rather than the one on screen: React has not
    // necessarily re-rendered since, and announcing the previous cell is worse than not
    // announcing at all.
    const box = dragged.current ?? tile?.box ?? null;
    if (tile !== undefined && box !== null) announce(`${nameOf(tile)} at ${describeBox(box)}`);
    dragged.current = null;
    setGesture(null);
  };

  /* ----------------------------------------------------------------- saving */

  const onSave = (): void => {
    setSaving(true);
    setFailure(null);
    const attempt = canvas;
    save(attempt)
      .then(() => {
        setSaved(attempt);
        announce('Saved');
      })
      .catch((error: unknown) => {
        // **The canvas is not rolled back.** A refused save is the one moment somebody's
        // afternoon is only in this tab; throwing it away to show a tidy error would be the
        // exact loss `If-Match` exists to prevent.
        setFailure(
          error instanceof ApiError
            ? error
            : new ApiError(0, 'UNREACHABLE', 'the core is not reachable', undefined),
        );
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const selectedTile = tileById(canvas, selected);

  const grid = useMemo(
    () => ({
      width: COLUMNS * CELL,
      height: ROWS * CELL,
      backgroundImage:
        'linear-gradient(to right, var(--ms-border) 1px, transparent 1px),' +
        'linear-gradient(to bottom, var(--ms-border) 1px, transparent 1px)',
      backgroundSize: `${String(CELL)}px ${String(CELL)}px`,
    }),
    [],
  );

  return (
    <div className="space-y-3">
      {/* The toolbar and the refusal under it are one block of the stack: the refusal is always
          there (`U-54`), and as a child of its own `space-y-3` would give it a margin while it
          says nothing. */}
      <div>
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="text-xs text-text-muted">
            <span className="ms-label block">Widget</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as WidgetKind);
              }}
              className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
            >
              {WIDGET_KINDS.map((one) => (
                <option key={one} value={one}>
                  {KIND_LABELS[one]}
                </option>
              ))}
            </select>
          </label>

          {needsObject && (
            <ObjectPicker
              kind={kind}
              value={target}
              onPick={(picked) => {
                setTarget(picked);
              }}
            />
          )}

          <button
            type="button"
            onClick={add}
            disabled={(needsObject && target === null) || disabled}
            className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
          >
            Add widget
          </button>

          {/*
          Only for a graph, and only when one is selected: a control that is present for every
          tile and does nothing on four of them is a control that teaches people to ignore it.
        */}
          {selectedTile?.kind === 'graph' && (
            <label className="text-xs text-text-muted">
              <span className="ms-label block">Range</span>
              <select
                value={selectedTile.rangeMinutes}
                onChange={(event) => {
                  apply(
                    retimeTile(canvas, selectedTile.id, Number(event.target.value)),
                    `${nameOf(selectedTile)} showing ${rangeLabel(Number(event.target.value))}`,
                  );
                }}
                className="mt-1 border border-control bg-surface px-2 py-1 text-sm text-text"
              >
                {RANGES.map((range) => (
                  <option key={range.minutes} value={range.minutes}>
                    {range.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={stepBack}
              disabled={!canUndo(line)}
              className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={stepForward}
              disabled={!canRedo(line)}
              className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
            >
              Redo
            </button>
            <button
              type="button"
              aria-pressed={connecting !== null}
              onClick={() => {
                if (connecting !== null) {
                  setConnecting(null);
                  announce('Connection abandoned');
                  return;
                }
                if (selectedTile === undefined) return;
                setConnecting(selectedTile.id);
                announce(`Connecting from ${nameOf(selectedTile)} — now choose the other widget`);
              }}
              disabled={(selected === null && connecting === null) || disabled}
              className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
            >
              {connecting === null ? 'Connect' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (selected !== null) remove(selected);
              }}
              disabled={selected === null || disabled}
              className="ms-label border border-control px-2 py-1 text-text-muted hover:text-text disabled:opacity-50"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving || disabled}
              className="border border-accent bg-accent px-3 py-1 text-sm font-medium text-accent-contrast disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        <RefusalPanel error={failure} className="mt-3 empty:mt-0">
          {failure?.code === 'MAP_CHANGED' && (
            <p className="mt-2 text-sm text-text-muted">
              Somebody else saved this map while it was open. Nothing here has been thrown away —
              open the map again in another tab to see what changed before saving over it.
            </p>
          )}
        </RefusalPanel>
      </div>

      <p className="text-xs text-text-muted">
        Tab reaches a widget. Arrow keys move it, Shift and an arrow resizes it, Delete removes it,
        and Ctrl or Cmd with Z steps back.
      </p>

      <div className="overflow-x-auto border border-border">
        <div
          role="group"
          aria-label="Map canvas"
          onKeyDown={onKeyDown}
          className="relative bg-bg"
          style={grid}
        >
          {mapId !== undefined && (
            <MapBackgroundImage src={backgroundUrl(mapId, backgroundNonce)} />
          )}

          <ConnectorLayer canvas={canvas} />

          {canvas.tiles.map((tile) => (
            <button
              key={tile.id}
              type="button"
              aria-pressed={tile.id === selected}
              aria-label={`${nameOf(tile)}, ${KIND_LABELS[tile.kind]}, ${describeBox(tile.box)}`}
              onFocus={() => {
                setSelected(tile.id);
              }}
              onClick={() => {
                if (connecting === null || connecting === tile.id) return;
                const next = connect(canvas, connecting, tile.id);
                setConnecting(null);
                if (next === canvas) {
                  announce('Those two are already connected');
                  return;
                }
                apply(next, `Connected to ${nameOf(tile)}`);
              }}
              onPointerDown={(event) => {
                begin(event, tile, 'move');
              }}
              onPointerMove={during}
              onPointerUp={end}
              onPointerCancel={end}
              className={`absolute overflow-hidden px-2 py-1 text-left ${
                tile.id === selected
                  ? 'border-2 border-accent bg-surface'
                  : 'border border-control bg-surface'
              }`}
              style={{
                left: tile.box.x * CELL,
                top: tile.box.y * CELL,
                width: tile.box.w * CELL,
                height: tile.box.h * CELL,
                touchAction: 'none',
              }}
            >
              <span className="ms-label block truncate">{KIND_LABELS[tile.kind]}</span>
              <span className="mt-0.5 block truncate text-sm text-text">{nameOf(tile)}</span>
            </button>
          ))}

          {/*
            A pointer affordance and nothing else — `aria-hidden`, no tab stop, no role. Resizing
            has a keyboard path already (Shift and an arrow), and a focusable handle whose Enter
            key does nothing is a control that lies about being one.
          */}
          {selectedTile !== undefined && !disabled && (
            <div
              aria-hidden="true"
              onPointerDown={(event) => {
                begin(event, selectedTile, 'resize');
              }}
              onPointerMove={during}
              onPointerUp={end}
              onPointerCancel={end}
              className="absolute cursor-se-resize border border-accent bg-accent"
              style={{
                left: (selectedTile.box.x + selectedTile.box.w) * CELL - 10,
                top: (selectedTile.box.y + selectedTile.box.h) * CELL - 10,
                width: 10,
                height: 10,
                touchAction: 'none',
              }}
            />
          )}
        </div>
      </div>

      {/*
        Every edit is announced here, because the canvas is the one view where the result of a
        key press is a position rather than a piece of text — there is nothing for a screen
        reader to read unless the position is said out loud.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>

      {/*
        **The lines, as text, and it is not only an accessibility afterthought.** An SVG line has
        no accessible name worth giving one, and a connection nobody can remove is a connection
        that has to be undone by deleting a widget. One list solves both: it says what is joined
        to what, and every row has the button that unjoins it.
      */}
      {selectedTile?.kind === 'html' && (
        <div className="space-y-1">
          <label className="text-xs text-text-muted" htmlFor="widget-html">
            <span className="ms-label block">Custom HTML</span>
          </label>
          <textarea
            id="widget-html"
            value={selectedTile.html}
            maxLength={MAX_HTML}
            rows={6}
            disabled={disabled}
            onChange={(event) => {
              apply(rewriteHtml(canvas, selectedTile.id, event.target.value), 'Markup changed');
            }}
            className="w-full border border-control bg-surface px-2 py-1 font-mono text-xs text-text"
          />
          {/*
            Said plainly, because the constraint is surprising and the alternative is somebody
            spending an afternoon on a stylesheet that will never load.
          */}
          <p className="text-xs text-text-muted">
            Drawn in a sandboxed frame with no access to this page, the session, or the network — so
            scripts do not run, external images and stylesheets do not load, and the tile will not
            match the rest of the page. Markup and text.
          </p>
        </div>
      )}

      {canvas.connectors.length > 0 && (
        <div>
          <h3 className="ms-label">Connections</h3>
          <ul className="mt-1 space-y-1">
            {canvas.connectors.map((line) => {
              const from = tileById(canvas, line.from);
              const to = tileById(canvas, line.to);
              const label = `${from === undefined ? line.from : nameOf(from)} to ${
                to === undefined ? line.to : nameOf(to)
              }`;
              return (
                <li key={line.id} className="flex items-center gap-2 text-xs text-text-muted">
                  <span>{label}</span>
                  <button
                    type="button"
                    onClick={() => {
                      apply(disconnect(canvas, line.id), `${label} disconnected`);
                    }}
                    disabled={disabled}
                    className="ms-label border border-control px-1.5 py-0.5 text-text-muted hover:text-text disabled:opacity-50"
                  >
                    <span className="sr-only">Disconnect </span>
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <MapGeoPanel
        canvas={canvas}
        selected={selectedTile}
        disabled={disabled}
        tilesConfigured={tilesConfigured}
        onChange={apply}
      />

      {mapId !== undefined && (
        <MapBackgroundControl
          mapId={mapId}
          disabled={disabled}
          onChanged={() => {
            setBackgroundNonce((was) => was + 1);
          }}
        />
      )}

      <p className="text-xs text-text-muted">
        {String(canvas.tiles.length)} widget{canvas.tiles.length === 1 ? '' : 's'}
        {canvas.connectors.length > 0
          ? `, ${String(canvas.connectors.length)} connection${canvas.connectors.length === 1 ? '' : 's'}`
          : ''}
        {dirty ? ' · unsaved changes' : ' · saved'}
      </p>
    </div>
  );
}
