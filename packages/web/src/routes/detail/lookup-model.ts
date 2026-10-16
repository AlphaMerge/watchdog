import type { ChannelRecord, LookupSummary } from '../../api/types';

export interface LookupOption {
  /** The lookup's id, or `''` for none. */
  readonly value: string;
  readonly label: string;
}

/**
 * What a channel's lookup can be set to, in the order offered (`U-82`).
 *
 * **The lookup its type declares first**, because that is the one an operator sent here by the
 * list of channels without their declared lookup (`P-308`) came to set. Then none, which judges
 * the channel by its limits. Then every other loaded lookup by name. A lookup the channel has that
 * this installation has not loaded is offered as it is, marked, so that the choice shown is the
 * one the channel has. A declared one that is not loaded is offered too: the core takes an id it
 * has not loaded, and the channel reads Warning until the lookup is.
 */
export function lookupOptions(
  channel: Pick<ChannelRecord, 'lookupId' | 'declaredLookup'>,
  lookups: readonly LookupSummary[] | null,
): LookupOption[] {
  const loaded = new Map((lookups ?? []).map((lookup) => [lookup.id, lookup]));
  const labelOf = (id: string): string => {
    const lookup = loaded.get(id);
    if (lookup !== undefined) return `${lookup.name} (${id})`;
    return lookups === null ? id : `${id}, not loaded`;
  };
  const options: LookupOption[] = [];
  const declared = channel.declaredLookup;
  if (declared !== null) {
    options.push({ value: declared, label: `${labelOf(declared)}, declared by its type` });
  }
  const current = channel.lookupId;
  if (current !== null && current !== declared && !loaded.has(current)) {
    options.push({ value: current, label: labelOf(current) });
  }
  options.push({ value: '', label: 'None: judged by its limits' });
  const others = [...loaded.values()]
    .filter((lookup) => lookup.id !== declared)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const lookup of others) options.push({ value: lookup.id, label: labelOf(lookup.id) });
  return options;
}
