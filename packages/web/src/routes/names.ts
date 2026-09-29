/**
 * Telling two of one name apart in a list (`L-06`).
 *
 * A map's, a report's and a library's name is unique only among what one account can read, so an
 * administrator — who reads everything — can be shown two "Core Network"s. A list gives the id
 * beside a name another row in it shares, and only then: an id on every row is noise. In the link
 * text rather than beside it, so the two links do not read alike to a screen reader either.
 */

/** The names more than one of these carries, compared case-folded as the core compares them. */
export function sharedNames(items: readonly { readonly name: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of items) {
    const key = name.toLowerCase();
    if (seen.has(key)) shared.add(key);
    else seen.add(key);
  }
  return shared;
}

/** The name as a list shows it: with its id when another row in the list shares it. */
export function listedName(
  item: { readonly id: number; readonly name: string },
  shared: ReadonlySet<string>,
): string {
  return shared.has(item.name.toLowerCase()) ? `${item.name} #${String(item.id)}` : item.name;
}
