/**
 * What a graph tile asks the core for (`G-04`).
 *
 * **Its own module, and not a helper beside the component**, for two reasons that happen to
 * agree: a file that exports both a component and a function loses fast refresh, and the
 * arithmetic here — a range in minutes, ending now — is the one part of a graph tile that can be
 * asserted without a canvas. `uPlot` does not mount under jsdom, so a test that could only reach
 * this through the rendered chart could not say which period a tile actually requested.
 */
export function historyPathFor(sensorId: number, rangeMinutes: number, now: Date): string {
  const from = new Date(now.getTime() - rangeMinutes * 60_000);
  return `/sensors/${String(sensorId)}/history?from=${from.toISOString()}&to=${now.toISOString()}`;
}
