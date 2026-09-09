/**
 * Where a shared map is read, from both sides (`G-06`).
 *
 * **Two URLs, and they are deliberately different.** `ADR-002` names one route; what it settles is
 * that the public surface is one token-scoped thing, not that a browser page and an API endpoint
 * share a path — and they cannot, because the API lives under `/api/v1` where the authentication
 * hook can exempt exactly one namespace, while the page has to be a route the app shell serves.
 */

/** The API the shared page reads. Inside `/api/v1/public/`, the one exempt namespace. */
export function sharedMapPath(token: string): string {
  return `/public/maps/${encodeURIComponent(token)}`;
}

export function sharedBackgroundUrl(token: string): string {
  return `/api/v1/public/maps/${encodeURIComponent(token)}/background`;
}

/** The page somebody is given. Absolute, because the whole point is to send it to a person. */
export function shareLinkFor(token: string, origin: string): string {
  return `${origin}/shared/${encodeURIComponent(token)}`;
}
