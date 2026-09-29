import { describe, expect, it } from 'vitest';
import { listedName, sharedNames } from '../src/routes/names';

/**
 * Two of one name in one list (`L-06`). A name is unique only among what one account can read, so
 * an administrator's lists can hold duplicates, and the id is what tells them apart.
 */
describe('a name another row shares', () => {
  const items = [
    { id: 4, name: 'Core Network' },
    { id: 9, name: 'core network' },
    { id: 12, name: 'Edge' },
  ];

  it('is found case-folded, as the core compares names', () => {
    expect([...sharedNames(items)]).toEqual(['core network']);
  });

  it('carries its id, and a name nobody shares does not', () => {
    const shared = sharedNames(items);
    expect(items.map((item) => listedName(item, shared))).toEqual([
      'Core Network #4',
      'core network #9',
      'Edge',
    ]);
  });
});
