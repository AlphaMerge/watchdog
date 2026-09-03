/**
 * A tab strip's keyboard ring, and the shape of one tab.
 *
 * Separate from the component because the wrapping is a decision that `test/detail-model.test.ts`
 * checks directly, and because a module exporting both a component and a function cannot Fast
 * Refresh.
 */

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  /** Shown after the label — a count, usually. Absent when there is nothing to say. */
  readonly badge?: string;
}

/**
 * Which tab a key moves to, or null when the key is not ours.
 *
 * Wrapping is deliberate and it is what the authoring practice specifies: a tab strip is a ring,
 * and stopping dead at the last tab makes it feel broken rather than bounded.
 */
export function nextTab(
  key: string,
  tabs: readonly TabDefinition[],
  active: string,
): string | null {
  if (tabs.length === 0) return null;
  const at = tabs.findIndex((tab) => tab.id === active);
  const from = at === -1 ? 0 : at;
  let index: number;
  switch (key) {
    case 'ArrowRight':
      index = (from + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      index = (from - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      index = 0;
      break;
    case 'End':
      index = tabs.length - 1;
      break;
    default:
      return null;
  }
  return tabs[index]?.id ?? null;
}
