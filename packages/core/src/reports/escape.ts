/**
 * HTML's five, for any report output that is markup (`E-04`, `E-05`).
 *
 * Its own module so that the HTML document and the SVG charts inside it escape operator text with
 * one function rather than two that agree today.
 */
export function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
