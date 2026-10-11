/**
 * The list of channels without the lookup their type declares (`P-308`): where it is, and what
 * its status line says, apart from the page that shows it.
 */

/** Where the list is, on the core as in the UI. */
export const WITHOUT_LOOKUP_PATH = '/channels/without-lookup';

/** How many there are, said as the first of more when the core cut the list. */
export function summary(shown: number, total: number): string {
  if (total > shown) {
    return `The first ${String(shown)} of ${String(total)} channels without their lookup, among the sensors you can see.`;
  }
  return shown === 1
    ? '1 channel without its lookup, among the sensors you can see.'
    : `${String(shown)} channels without their lookup, among the sensors you can see.`;
}
