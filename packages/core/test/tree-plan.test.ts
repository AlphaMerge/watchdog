import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ObjectError } from '../src/objects/errors.js';
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  planTree,
  type TreeNodeInput,
} from '../src/objects/tree-plan.js';

/**
 * Ordering a described subtree, with no database (`P-19`).
 *
 * **This is where the mistakes are**, which is why it is a pure function: the transaction that
 * follows is a handful of batched inserts, and what decides whether it produces the tree the
 * caller meant is the ordering, the reference resolution and the kind rules. None of those need
 * a database to be wrong.
 *
 * Every refusal is checked for *naming the node*, not merely for refusing. A caller sending five
 * thousand nodes cannot act on "invalid request".
 */

const group = (ref: string, parentRef?: string): TreeNodeInput => ({
  kind: 'group',
  name: ref,
  ref,
  ...(parentRef === undefined ? {} : { parentRef }),
});

const device = (ref: string, parentRef?: string): TreeNodeInput => ({
  kind: 'device',
  name: ref,
  host: '192.0.2.1',
  ref,
  ...(parentRef === undefined ? {} : { parentRef }),
});

const sensor = (ref: string, parentRef: string): TreeNodeInput => ({
  kind: 'sensor',
  name: ref,
  sensorType: 'icmp.ping',
  ref,
  parentRef,
});

const refsOf = (levels: { ref: string | undefined }[][]): (string | undefined)[][] =>
  levels.map((level) => level.map((node) => node.ref));

function refuses(nodes: TreeNodeInput[], match: RegExp, parentKind = 'probe' as const): void {
  assert.throws(
    () => planTree({ parentId: 1, nodes }, parentKind),
    (error: unknown) => {
      assert.ok(error instanceof ObjectError, `not an ObjectError: ${String(error)}`);
      assert.equal(error.code, 'OBJECT_INVALID');
      assert.match(error.message, match);
      return true;
    },
  );
}

describe('planning a subtree', () => {
  it('puts a parent in an earlier level than its children', () => {
    const plan = planTree(
      {
        parentId: 1,
        nodes: [sensor('s1', 'd1'), device('d1', 'g1'), group('g1')],
      },
      'probe',
    );
    // Sent leaf-first on purpose: a caller building from a template has no reason to sort, and
    // a planner that required them to would push this work onto every one of them.
    assert.deepEqual(refsOf(plan.levels), [['g1'], ['d1'], ['s1']]);
    assert.equal(plan.count, 3);
  });

  it('puts everything with no parentRef in the first level', () => {
    const plan = planTree({ parentId: 1, nodes: [group('a'), group('b'), group('c')] }, 'probe');
    assert.deepEqual(refsOf(plan.levels), [['a', 'b', 'c']]);
  });

  it('keeps a node with no ref, since a leaf nobody points at needs no handle', () => {
    const plan = planTree(
      {
        parentId: 1,
        nodes: [
          { kind: 'device', name: 'plain', host: '192.0.2.9' },
          { kind: 'device', name: 'named', host: '192.0.2.10', ref: 'd' },
        ],
      },
      'probe',
    );
    assert.deepEqual(refsOf(plan.levels), [[undefined, 'd']]);
  });

  it('resolves a chain of groups into one level each', () => {
    const nodes = [group('g1'), group('g2', 'g1'), group('g3', 'g2'), device('d', 'g3')];
    const plan = planTree({ parentId: 1, nodes }, 'probe');
    assert.deepEqual(refsOf(plan.levels), [['g1'], ['g2'], ['g3'], ['d']]);
  });

  it('names the node whose parent nothing creates', () => {
    refuses([device('d', 'nowhere')], /node 0 \("d"\).*"nowhere".*nothing in this request creates/);
  });

  it('names both nodes that claim the same ref', () => {
    // Letting the second win would attach children to whichever node the caller did not mean,
    // and the tree would be wrong rather than refused.
    refuses([group('same'), group('same')], /both call themselves "same" \(0 and 1\)/);
  });

  it('names a node that is its own parent', () => {
    refuses([group('loop', 'loop')], /node 0 \("loop"\) is its own parent/);
  });

  it('names a node in a reference loop, rather than reporting a depth', () => {
    // Two nodes pointing at each other reach no level, and a depth limit would be the wrong
    // diagnosis: a legitimately deep tree hits that too.
    refuses([group('a', 'b'), group('b', 'a')], /is in a loop of parent references/);
  });

  it('refuses a kind its parent cannot hold, whether the parent exists or is being created', () => {
    // Under an existing probe.
    refuses(
      [sensor('s', 'g'), group('g')],
      /node 0 \("s"\) is a sensor, which cannot go under a group/,
    );
    // Directly under the request's own parent.
    refuses([{ kind: 'sensor', name: 's', sensorType: 'icmp.ping' }], /cannot go under a probe/);
    // And a probe, which may only go under the root.
    refuses([{ kind: 'probe', name: 'p' }], /is a probe, which cannot go under a probe/);
  });

  it('accepts what the object model does accept', () => {
    assert.doesNotThrow(() =>
      planTree({ parentId: 1, nodes: [group('g'), device('d', 'g'), sensor('s', 'd')] }, 'probe'),
    );
    assert.doesNotThrow(() =>
      planTree({ parentId: 1, nodes: [{ kind: 'probe', name: 'p' }] }, 'root'),
    );
  });

  it('refuses an empty request rather than answering that it created nothing', () => {
    refuses([], /no nodes in it/);
  });

  it('refuses more nodes than one request may create', () => {
    const nodes = Array.from({ length: MAX_TREE_NODES + 1 }, (_v, i) => group(`g${String(i)}`));
    refuses(nodes, new RegExp(`${String(MAX_TREE_NODES + 1)} nodes is more than`));
  });

  it('takes exactly the limit', () => {
    const nodes = Array.from({ length: MAX_TREE_NODES }, (_v, i) => group(`g${String(i)}`));
    assert.equal(planTree({ parentId: 1, nodes }, 'probe').count, MAX_TREE_NODES);
  });

  it('refuses a subtree deeper than the limit', () => {
    // Not a business rule: it is what stops a request whose refs describe a very deep chain from
    // becoming one statement per node wearing the shape of one request.
    const nodes: TreeNodeInput[] = [group('g0')];
    for (let i = 1; i <= MAX_TREE_DEPTH; i += 1) {
      nodes.push(group(`g${String(i)}`, `g${String(i - 1)}`));
    }
    refuses(nodes, new RegExp(`more than ${String(MAX_TREE_DEPTH)} levels deep`));
  });

  it('scales to the v1 target without needing the caller to sort it', () => {
    // Ninety-four groups, thirteen devices each, three sensors each — the shape
    // `tree-build-performance` builds, sized to sit inside the limit, and sent in an order
    // nobody arranged.
    const nodes: TreeNodeInput[] = [];
    for (let g = 0; g < 94; g += 1) {
      for (let d = 0; d < 13; d += 1) {
        for (let s = 0; s < 3; s += 1) {
          nodes.push(
            sensor(`s-${String(g)}-${String(d)}-${String(s)}`, `d-${String(g)}-${String(d)}`),
          );
        }
        nodes.push(device(`d-${String(g)}-${String(d)}`, `g-${String(g)}`));
      }
      nodes.push(group(`g-${String(g)}`));
    }

    const plan = planTree({ parentId: 1, nodes }, 'probe');
    assert.equal(plan.count, nodes.length);
    assert.equal(plan.levels.length, 3, 'groups, then devices, then sensors');
    assert.deepEqual(
      plan.levels.map((level) => level.length),
      [94, 1_222, 3_666],
    );
    assert.ok(plan.count <= MAX_TREE_NODES, 'and the whole thing fits in one request');
  });
});
