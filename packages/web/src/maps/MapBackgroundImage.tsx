import { useEffect, useState } from 'react';
import { CELL, COLUMNS, ROWS } from './canvas';
import { backgroundUrl } from './background';

/**
 * The floor plan behind the widgets (`G-05`).
 *
 * **A plain `img` that hides itself on error, rather than a metadata request first.** Most maps
 * have no background, and asking "is there one?" before asking for it would be two requests for
 * every map to save one 404 on the ones without. The 404 costs a row lookup and nothing renders.
 *
 * **Fitted, never stretched.** `object-contain` keeps a plan's aspect ratio: a rack diagram
 * stretched to a 32×48 grid is a diagram whose proportions lie, and the widgets sitting on it are
 * placed against those proportions.
 *
 * `alt` is empty and `aria-hidden` set on purpose. A background is decoration in the WCAG sense —
 * the information on this canvas is the widgets, which carry their own names — and a screen reader
 * announcing "floor plan" before forty tiles is noise in front of the content.
 */
export function MapBackgroundImage({
  mapId,
  nonce = 0,
}: {
  readonly mapId: number;
  readonly nonce?: number;
}): React.JSX.Element | null {
  const [broken, setBroken] = useState(false);

  // A new nonce means a new upload: whatever failed before is not what is there now.
  useEffect(() => {
    setBroken(false);
  }, [nonce]);

  if (broken) return null;

  return (
    <img
      src={backgroundUrl(mapId, nonce)}
      alt=""
      aria-hidden="true"
      onError={() => {
        setBroken(true);
      }}
      className="pointer-events-none absolute left-0 top-0 object-contain"
      style={{ width: COLUMNS * CELL, height: ROWS * CELL }}
    />
  );
}
