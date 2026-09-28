import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_DEPTH,
  MAX_NODES,
  countNodes,
  describeNodes,
  validateNodes,
  type LibraryNode,
} from '../src/libraries/nodes.js';
import { LibraryError } from '../src/libraries/errors.js';

/**
 * What a library document may hold (`L-01`).
 *
 * **Table-driven, because each row is a way a document could quietly answer a different
 * question.** A node whose `rule` was misspelt `rules` would, read leniently, be a heading and
 * show nothing; a rule whose `states` was a string would, read leniently, show every state. Every
 * refusal here is one of those, and the path in its message is what lets an editor find the node.
 */

/** The path a refusal names, or a failure saying the document was accepted. */
function refusal(raw: unknown): string {
  try {
    validateNodes(raw);
  } catch (error) {
    assert.ok(error instanceof LibraryError, `not a LibraryError: ${String(error)}`);
    assert.equal(error.code, 'LIBRARY_INVALID');
    assert.equal(error.status, 400);
    return String(error.details['path']);
  }
  assert.fail(`accepted ${JSON.stringify(raw)}`);
}

const leaf = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: id,
  ...extra,
});

/** A chain of nodes, one inside the next, `depth` levels deep. */
function chain(depth: number): unknown[] {
  let node: Record<string, unknown> = leaf(`n${String(depth)}`);
  for (let level = depth - 1; level >= 1; level -= 1) {
    node = { ...leaf(`n${String(level)}`), children: [node] };
  }
  return [node];
}

describe('library nodes', () => {
  it('reads a document, filling in what may be left out', () => {
    const nodes = validateNodes([
      {
        id: 'customer-a',
        name: '  Customer A  ',
        children: [
          {
            id: 'routers',
            name: 'Routers',
            rule: { roots: [12], types: ['snmp.traffic'], tags: ['Core'], states: ['down'] },
          },
          { id: 'all', name: 'Everything', rule: {} },
        ],
      },
    ]);
    assert.deepEqual(nodes, [
      {
        id: 'customer-a',
        // Trimmed, as every other name in the system is.
        name: 'Customer A',
        // Absent is a heading.
        rule: null,
        children: [
          {
            id: 'routers',
            name: 'Routers',
            // Stored as written: folding is how a tag is *compared*, not how it is kept.
            rule: { roots: [12], types: ['snmp.traffic'], tags: ['Core'], states: ['down'] },
            children: [],
          },
          {
            id: 'all',
            name: 'Everything',
            // An empty rule is not a heading: it asks for everything the viewer may read.
            rule: { roots: [], types: [], tags: [], states: [] },
            children: [],
          },
        ],
      },
    ]);
  });

  it('accepts exactly the limits, so a bound is not off by one', () => {
    assert.equal(countNodes(validateNodes(chain(MAX_DEPTH))), MAX_DEPTH);
    const wide = Array.from({ length: MAX_NODES }, (_, index) => leaf(`n${String(index)}`));
    assert.equal(countNodes(validateNodes(wide)), MAX_NODES);
  });

  const refused: [string, unknown, string][] = [
    ['not a list', { id: 'a' }, 'nodes'],
    ['a node that is not an object', ['a'], 'nodes[0]'],
    ['a field a node does not have', [leaf('a', { rules: { tags: ['x'] } })], 'nodes[0]'],
    ['an id with a space', [leaf('a b')], 'nodes[0].id'],
    ['an id too long', [leaf('x'.repeat(41))], 'nodes[0].id'],
    ['no name', [{ id: 'a' }], 'nodes[0].name'],
    ['a name of spaces', [{ id: 'a', name: '   ' }], 'nodes[0].name'],
    ['a name too long', [{ id: 'a', name: 'x'.repeat(101) }], 'nodes[0].name'],
    [
      'an id used twice, in different branches',
      [leaf('a', { children: [leaf('b')] }), leaf('c', { children: [leaf('b')] })],
      'nodes[1].children[0].id',
    ],
    ['children that are not a list', [leaf('a', { children: {} })], 'nodes[0].children'],
    ['a rule that is not an object', [leaf('a', { rule: 'down' })], 'nodes[0].rule'],
    ['a field a rule does not have', [leaf('a', { rule: { state: ['down'] } })], 'nodes[0].rule'],
    ['states as a string', [leaf('a', { rule: { states: 'down' } })], 'nodes[0].rule.states'],
    [
      'a state that is not one',
      [leaf('a', { rule: { states: ['broken'] } })],
      'nodes[0].rule.states[0]',
    ],
    ['a root of zero', [leaf('a', { rule: { roots: [0] } })], 'nodes[0].rule.roots[0]'],
    ['a root as a string', [leaf('a', { rule: { roots: ['12'] } })], 'nodes[0].rule.roots[0]'],
    ['a fractional root', [leaf('a', { rule: { roots: [1.5] } })], 'nodes[0].rule.roots[0]'],
    ['a root listed twice', [leaf('a', { rule: { roots: [3, 3] } })], 'nodes[0].rule.roots[1]'],
    [
      'a type in capitals',
      [leaf('a', { rule: { types: ['SNMP.traffic'] } })],
      'nodes[0].rule.types[0]',
    ],
    ['a type with no dot', [leaf('a', { rule: { types: ['ping'] } })], 'nodes[0].rule.types[0]'],
    ['an empty tag', [leaf('a', { rule: { tags: [''] } })], 'nodes[0].rule.tags[0]'],
    ['a tag too long', [leaf('a', { rule: { tags: ['x'.repeat(101)] } })], 'nodes[0].rule.tags[0]'],
    [
      // **Folded**: a rule that seemed to ask for both would be asking for one.
      'one tag twice in different case',
      [leaf('a', { rule: { tags: ['Berlin', 'berlin'] } })],
      'nodes[0].rule.tags[1]',
    ],
    [
      'too many roots',
      [leaf('a', { rule: { roots: Array.from({ length: 51 }, (_, i) => i + 1) } })],
      'nodes[0].rule.roots',
    ],
    ['one level too deep', chain(MAX_DEPTH + 1), `nodes[0]${'.children[0]'.repeat(MAX_DEPTH)}`],
    [
      'one node too many, counted across levels',
      [
        leaf('top', {
          children: Array.from({ length: MAX_NODES }, (_, index) => leaf(`n${String(index)}`)),
        }),
      ],
      `nodes[0].children[${String(MAX_NODES - 1)}]`,
    ],
  ];

  for (const [what, raw, path] of refused) {
    it(`refuses ${what}, naming ${path}`, () => {
      assert.equal(refusal(raw), path);
    });
  }

  it('writes the document as lines a person can read in an audit diff', () => {
    const nodes: LibraryNode[] = validateNodes([
      {
        id: 'a',
        name: 'Customer A',
        children: [
          {
            id: 'r',
            name: 'Routers',
            rule: { roots: [12, 40], types: ['snmp.traffic'], states: ['down', 'warning'] },
          },
          { id: 'e', name: 'Everything', rule: {} },
        ],
      },
      { id: 't', name: 'Tagged', rule: { tags: ['core', 'berlin'] } },
    ]);
    assert.equal(
      describeNodes(nodes),
      [
        'Customer A',
        'Customer A › Routers: under #12, #40; types snmp.traffic; states down, warning',
        // Said, rather than left blank: a blank would read as a node asking for nothing.
        'Customer A › Everything: every sensor',
        'Tagged: tags core, berlin',
      ].join('\n'),
    );
    assert.equal(describeNodes([]), '');
  });
});
