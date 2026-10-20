import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CREDENTIAL_KINDS } from '@ms/sensors';
import { notificationMethods } from '../src/notifications/methods.js';
import { coreCatalogue } from '../src/profile.js';
import { settingRegistry } from '../src/settings/registry.js';
import { triggerKinds } from '../src/triggers/definition.js';

/**
 * What the form calls a list, and one entry of it, in every schema the core serves (`U-91`).
 *
 * The web UI draws an array as a repeating control (`U-12`). It names the list by the property's
 * `title`, and each entry and the buttons that move and remove it by `items.title`, falling back
 * to the list's name where the item has none and to the property's own key where the list has
 * none. `U-88` gave every list in `packages/sensors` both; the program method's `args` and
 * `secretArgs` had neither, so a template's form read "Args 1", "Remove Args 1" and "Secret args
 * 1". These are every schema `SchemaForm` is handed: a sensor type's parameters
 * (`GET /sensor-types`), a credential kind's (`GET /credential-kinds`), a method's settings
 * (`GET /notification-methods`), a trigger kind's (`GET /trigger-kinds`) and an inheritable
 * setting's value (`GET /objects/{id}/settings`).
 */

interface List {
  readonly path: string;
  readonly title: unknown;
  readonly entry: unknown;
}

/** Every array the form would draw as a list, by its path, with its own name and its entry's. */
function listsIn(schema: unknown, path: string): List[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as {
    type?: unknown;
    title?: unknown;
    items?: unknown;
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  const found: List[] = [];
  const array = node.type === 'array' || (Array.isArray(node.type) && node.type.includes('array'));
  if (array && typeof node.items === 'object' && node.items !== null) {
    found.push({ path, title: node.title, entry: (node.items as { title?: unknown }).title });
    found.push(...listsIn(node.items, `${path}[]`));
  }
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    found.push(...listsIn(property, path === '' ? name : `${path}.${name}`));
  }
  if (typeof node.additionalProperties === 'object') {
    found.push(...listsIn(node.additionalProperties, `${path}.*`));
  }
  return found;
}

/** Every schema the core hands a form, by where it is served. */
function servedSchemas(): { readonly where: string; readonly schema: unknown }[] {
  return [
    ...coreCatalogue('full')
      .summaries()
      .map((type) => ({ where: `sensor type ${type.id}`, schema: type.paramsSchema })),
    ...CREDENTIAL_KINDS.map((kind) => ({
      where: `credential kind ${kind.id}`,
      schema: kind.schema,
    })),
    ...notificationMethods
      .all()
      .map((method) => ({ where: `method ${method.id}`, schema: method.settingsSchema })),
    ...triggerKinds
      .all()
      .map((kind) => ({ where: `trigger kind ${kind.id}`, schema: kind.settingsSchema })),
    ...settingRegistry
      .definitions()
      .map((setting) => ({ where: `setting ${setting.key}`, schema: setting.schema })),
  ];
}

const untitled = (lists: readonly List[]): string[] =>
  lists.flatMap((list) => [
    ...(typeof list.title === 'string' && list.title !== '' ? [] : [`${list.path}: the list`]),
    ...(typeof list.entry === 'string' && list.entry !== '' ? [] : [`${list.path}: its entry`]),
  ]);

describe('the name of a list and of one entry of it, in every schema the core serves (U-91)', () => {
  it('is given by the program method, for its arguments and its secret ones', () => {
    const lists = listsIn(notificationMethods.get('program').settingsSchema, '');
    assert.deepEqual(lists, [
      { path: 'args', title: 'Arguments', entry: 'Argument' },
      { path: 'secretArgs', title: 'Secret arguments', entry: 'Secret argument' },
    ]);
  });

  it('is given by every list in every schema a form is generated from', () => {
    const lists = servedSchemas().flatMap(({ where, schema }) =>
      listsIn(schema, '').map((list) => ({ ...list, path: `${where}: ${list.path}` })),
    );
    // The sensor types' and credential kinds' lists, and the program method's two.
    assert.ok(lists.length > 30, String(lists.length));
    assert.ok(
      lists.some((list) => list.path === 'method program: secretArgs'),
      'the walk reaches the methods',
    );
    assert.deepEqual(untitled(lists), []);
  });
});
