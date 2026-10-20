import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JsonSchema } from '../src/contract.js';
import { CREDENTIAL_KINDS } from '../src/credentials/index.js';
import { BUILT_IN_SENSOR_TYPES } from '../src/index.js';

/**
 * What the form calls one entry of a list (`U-88`).
 *
 * The web UI draws an array as a repeating control (`U-12`) and names each entry, and the buttons
 * that move and remove it, by `items.title` — "Step 2", "Remove Step 2" — falling back to the
 * list's own title where the item has none. Walked in a browser (`U-23`), a credential set's
 * targets read "Allowed targets 1", "Remove Allowed targets 1" and "Add allowed targets", and an
 * SSH set's host keys the same: both lists had no item title. A screen reader says that name and
 * nothing else of the entry, so every list a shipped schema declares names its entry.
 */

/** Every array the form would draw as a list, by its path, with what it calls an entry. */
function listsIn(schema: JsonSchema, path = ''): { path: string; title: unknown }[] {
  const node = schema as {
    type?: unknown;
    items?: JsonSchema;
    properties?: Record<string, JsonSchema>;
  };
  const found: { path: string; title: unknown }[] = [];
  if (node.type === 'array' && node.items !== undefined && typeof node.items === 'object') {
    found.push({ path, title: (node.items as { title?: unknown }).title });
    found.push(...listsIn(node.items, `${path}[]`));
  }
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    found.push(...listsIn(property, path === '' ? name : `${path}.${name}`));
  }
  return found;
}

describe('the name of one entry of a list (U-88)', () => {
  it('is given by every credential kind, for its targets and its host keys too', () => {
    const lists = CREDENTIAL_KINDS.flatMap((kind) =>
      listsIn(kind.schema).map((list) => ({ ...list, path: `${kind.id}: ${list.path}` })),
    );
    // Every kind has allowed targets, and SSH has host keys as well.
    assert.ok(lists.length >= CREDENTIAL_KINDS.length + 1, String(lists.length));
    assert.deepEqual(
      lists.filter((list) => typeof list.title !== 'string').map((list) => list.path),
      [],
    );
    assert.deepEqual(
      lists
        .filter((list) => /(?:allowedTargets|hostKeys)$/u.test(list.path))
        .map((list) => list.title),
      CREDENTIAL_KINDS.flatMap((kind) =>
        kind.id === 'ssh' ? ['Host key', 'Allowed target'] : ['Allowed target'],
      ),
    );
  });

  it('is given by every list any shipped sensor type takes, of strings or of objects', () => {
    const lists = BUILT_IN_SENSOR_TYPES.flatMap((type) =>
      listsIn(type.paramsSchema).map((list) => ({ ...list, path: `${type.id}: ${list.path}` })),
    );
    assert.ok(lists.length > 20, String(lists.length));
    assert.deepEqual(
      lists.filter((list) => typeof list.title !== 'string').map((list) => list.path),
      [],
    );
  });
});
