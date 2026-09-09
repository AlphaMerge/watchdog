import { CELL, COLUMNS, ROWS, connectorLine, tileById, type Canvas } from './canvas';

/**
 * The lines between tiles (`G-05`).
 *
 * **One SVG behind every tile, not one element per line.** A line has to be able to cross a tile's
 * corner and pass under the next one; drawing each into its own absolutely-positioned box means
 * computing a bounding box per line and stacking order per pair, for no gain.
 *
 * **`aria-hidden`, and that is not the accessibility story being skipped.** A line is a shape with
 * no name worth announcing, and a screen reader walking forty `<line>` elements learns nothing.
 * What a reader needs is *which tile is joined to which*, and that is a list of text — the designer
 * renders one under the canvas, with the button that removes each connection, and the board
 * renders the same list visually hidden. The picture and the text say the same thing.
 */
export function ConnectorLayer({ canvas }: { readonly canvas: Canvas }): React.JSX.Element | null {
  if (canvas.connectors.length === 0) return null;

  return (
    <svg
      aria-hidden="true"
      // Not `pointer-events: none` on the SVG alone — the element covers the whole canvas, and
      // without this every click meant for a tile would land here instead.
      className="pointer-events-none absolute left-0 top-0"
      width={COLUMNS * CELL}
      height={ROWS * CELL}
    >
      {canvas.connectors.map((line) => {
        const from = tileById(canvas, line.from);
        const to = tileById(canvas, line.to);
        // A line whose endpoint is not on the canvas has no geometry. It cannot happen from the
        // designer — removing a tile removes its lines — but the document is caller-supplied.
        if (from === undefined || to === undefined) return null;
        const ends = connectorLine(from.box, to.box);
        return (
          <line
            key={line.id}
            x1={ends.x1}
            y1={ends.y1}
            x2={ends.x2}
            y2={ends.y2}
            // The control-border grey, which is the one that clears 3:1 against every surface
            // (`U-11`). A line carrying meaning is not a divider and does not get the divider grey.
            stroke="var(--ms-control-border)"
            strokeWidth={2}
          />
        );
      })}
    </svg>
  );
}
