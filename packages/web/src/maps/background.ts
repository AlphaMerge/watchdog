/**
 * Where a map's background image lives, from the browser's side (`G-05`, `ADR-003`).
 *
 * Its own module rather than a constant beside a component, for the same reason `graph.ts` is: a
 * file exporting a component and a helper loses fast refresh, and this is the piece worth
 * asserting without rendering anything.
 */

/** `ADR-003` Decision 2, repeated here so the browser can refuse before spending the upload. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * The image's URL.
 *
 * **Stable, and that is the whole cache story**: the bytes are addressed by a strong `ETag`, so a
 * second visit revalidates in one small request instead of downloading the plan again. `nonce` is
 * the exception and only after a change in this tab — the URL being stable is exactly what would
 * otherwise leave somebody looking at the plan they just replaced.
 */
export function backgroundUrl(mapId: number, nonce = 0): string {
  const path = `/api/v1/maps/${String(mapId)}/background`;
  return nonce === 0 ? path : `${path}?v=${String(nonce)}`;
}
