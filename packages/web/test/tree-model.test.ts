import { describe, expect, it } from 'vitest';
import type { LiveState } from '../src/api/stream';
import type { ObjectSummary, SensorState } from '../src/api/types';
import { EMPTY_TREE, flatten, rollup, stateFor, worstOf, type TreeState } from '../src/tree/model';
import { visibleRange } from '../src/components/VirtualList';

function node(id: number, parentId: number, over: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    id,
    parentId,
    kind: 'group',
    name: `n${String(id)}`,
    tags: [],
    priority: 3,
    version: 1,
    hasChildren: false,
    ...over,
  };
}

function tree(over: Partial<TreeState> = {}): TreeState {
  return { ...EMPTY_TREE, ...over };
}

function live(sensorId: number, path: number[], state: SensorState): LiveState {
  return {
    sensorId,
    sensorName: `s${String(sensorId)}`,
    path,
    state,
    cause: 'scan',
    message: '',
    at: '',
  };
}

describe('flattening the tree', () => {
  const state = tree({
    children: new Map([
      [1, [node(2, 1, { hasChildren: true }), node(9, 1)]],
      [2, [node(3, 2, { hasChildren: true })]],
      [3, [node(4, 3, { kind: 'sensor' })]],
    ]),
  });

  it('shows nothing until the root’s children are loaded', () => {
    expect(flatten(EMPTY_TREE, 1)).toEqual([]);
    expect(flatten(state, null)).toEqual([]);
  });

  it('shows one level while everything is closed', () => {
    expect(flatten(state, 1).map((row) => row.object.id)).toEqual([2, 9]);
  });

  it('opens a branch in place, at the right depth', () => {
    const open = tree({ ...state, expanded: new Set([2, 3]) });
    expect(open.expanded.size).toBe(2);
    const rows = flatten(open, 1);
    expect(rows.map((row) => row.object.id)).toEqual([2, 3, 4, 9]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 0]);
  });

  it('shows an opened branch whose children have not arrived as empty, not missing', () => {
    const opening = tree({
      children: new Map([[1, [node(2, 1, { hasChildren: true })]]]),
      expanded: new Set([2]),
      loading: new Set([2]),
    });
    const rows = flatten(opening, 1);
    expect(rows.map((row) => row.object.id)).toEqual([2]);
    expect(rows[0]?.loading).toBe(true);
    expect(rows[0]?.expanded).toBe(true);
  });

  it('does not recurse, so a deep tree cannot blank the page', () => {
    // Operator-shaped trees are shallow "in practice", and in practice is not a bound.
    const children = new Map<number, ObjectSummary[]>();
    const expanded = new Set<number>();
    for (let depth = 1; depth <= 5_000; depth += 1) {
      children.set(depth, [node(depth + 1, depth, { hasChildren: true })]);
      expanded.add(depth + 1);
    }
    expect(flatten(tree({ children, expanded }), 1).length).toBe(5_000);
  });
});

describe('rolling a state up', () => {
  it('takes the worst thing beneath a container', () => {
    const worst = rollup([
      live(10, [1, 2, 10], 'up'),
      live(11, [1, 2, 11], 'warning'),
      live(12, [1, 3, 12], 'down'),
    ]);
    expect(worst.get(2)).toBe('warning');
    expect(worst.get(3)).toBe('down');
    // The root sees the worst of everything beneath it, across branches.
    expect(worst.get(1)).toBe('down');
  });

  it('does not let a paused sensor colour a group as a problem', () => {
    // Somebody switched it off on purpose. A group going amber because one sensor is paused is
    // how an operator learns to ignore the colour.
    expect(worstOf('up', 'paused')).toBe('up');
    expect(worstOf('warning', 'paused')).toBe('warning');
    const worst = rollup([live(10, [1, 2, 10], 'paused'), live(11, [1, 2, 11], 'up')]);
    expect(worst.get(2)).toBe('up');
  });

  it('ranks an acknowledged down below a plain one, and both above a warning', () => {
    expect(worstOf('down_acknowledged', 'down')).toBe('down');
    expect(worstOf('warning', 'down_acknowledged')).toBe('down_acknowledged');
  });

  it('colours a collapsed group from sensors that were never loaded', () => {
    // The reason `U-02` puts the absolute path in every event: the rollup needs no tree at all.
    const worst = rollup([live(10, [1, 2, 3, 10], 'down')]);
    const group = node(2, 1, { kind: 'group' });
    expect(stateFor(group, new Map(), worst)).toBe('down');
  });

  it('says nothing about a container with nothing beneath it', () => {
    // Grey would be a claim. A group with no sensors under it has no status.
    expect(stateFor(node(2, 1), new Map(), new Map())).toBeUndefined();
  });

  it('prefers the stream’s state for a sensor, and the page load’s when it has none', () => {
    const sensor = node(10, 2, { kind: 'sensor', state: 'up' });
    expect(stateFor(sensor, new Map(), new Map())).toBe('up');
    expect(stateFor(sensor, new Map([[10, live(10, [1, 10], 'down')]]), new Map())).toBe('down');
  });
});

describe('the visible window', () => {
  it('draws only what fits, plus the overscan', () => {
    const window = visibleRange({
      count: 5_000,
      rowHeight: 36,
      height: 560,
      scrollTop: 0,
      overscan: 8,
    });
    expect(window.start).toBe(0);
    expect(window.end).toBeLessThan(40);
  });

  it('moves with the scroll', () => {
    const window = visibleRange({
      count: 5_000,
      rowHeight: 36,
      height: 560,
      scrollTop: 36 * 1_000,
      overscan: 8,
    });
    expect(window.start).toBe(992);
    expect(window.end).toBeGreaterThan(1_000);
  });

  it('stops at the end of the list', () => {
    const window = visibleRange({
      count: 100,
      rowHeight: 36,
      height: 560,
      scrollTop: 36 * 10_000,
      overscan: 8,
    });
    expect(window.end).toBe(100);
    expect(window.start).toBeLessThanOrEqual(100);
  });

  it('draws nothing for an empty list', () => {
    expect(
      visibleRange({ count: 0, rowHeight: 36, height: 560, scrollTop: 0, overscan: 8 }),
    ).toEqual({
      start: 0,
      end: 0,
    });
  });
});

/**
 * `PLAN.md`'s Phase 5 criterion is a tree that stays responsive at 5,000 sensors, and
 * `CLAUDE.md` says a performance claim needs a measurement rather than an assertion.
 *
 * What this measures is the work this task added: flattening the visible rows and rolling 5,000
 * sensor states up their ancestor paths, which is what happens on every stream event. It does
 * **not** measure the browser's paint — that needs a real browser and belongs with `U-11`. The
 * point of the bound is that neither of these is where a slow tree would come from.
 */
describe('at five thousand sensors', () => {
  const DEVICES = 200;
  const PER_DEVICE = 25;

  function installation(): { state: TreeState; states: LiveState[] } {
    const children = new Map<number, ObjectSummary[]>();
    const expanded = new Set<number>();
    const states: LiveState[] = [];
    const devices: ObjectSummary[] = [];
    let nextId = 1_000;

    for (let d = 0; d < DEVICES; d += 1) {
      const deviceId = 100 + d;
      devices.push(node(deviceId, 1, { kind: 'device', hasChildren: true }));
      expanded.add(deviceId);
      const sensors: ObjectSummary[] = [];
      for (let s = 0; s < PER_DEVICE; s += 1) {
        nextId += 1;
        sensors.push(node(nextId, deviceId, { kind: 'sensor' }));
        states.push(live(nextId, [1, 2, deviceId, nextId], s === 0 ? 'down' : 'up'));
      }
      children.set(deviceId, sensors);
    }
    children.set(1, devices);
    return { state: tree({ children, expanded }), states };
  }

  it('flattens and rolls up 5,000 sensors in a few milliseconds', () => {
    const { state, states } = installation();
    expect(states.length).toBe(5_000);

    const started = performance.now();
    const rows = flatten(state, 1);
    const worst = rollup(states);
    const elapsed = performance.now() - started;

    expect(rows.length).toBe(DEVICES + DEVICES * PER_DEVICE);
    expect(worst.get(100)).toBe('down');
    expect(worst.get(1)).toBe('down');
    // Printed, the way the core's perf tests print theirs: a number in a passing test is worth
    // more than a bound nobody reads.
    // eslint-disable-next-line no-console
    console.log(
      `    measured: ${String(rows.length)} rows flattened and ${String(states.length)} ` +
        `states rolled up in ${elapsed.toFixed(1)} ms`,
    );
    // Generous on purpose: this runs on whatever CI is given, and the claim is "not the
    // bottleneck", not a specific number. Measured at 4.0 ms on the dev container.
    expect(elapsed, `flatten + rollup took ${elapsed.toFixed(1)} ms`).toBeLessThan(250);
  });

  it('draws a few dozen rows out of five thousand', () => {
    const { state } = installation();
    const rows = flatten(state, 1);
    const window = visibleRange({
      count: rows.length,
      rowHeight: 36,
      height: 560,
      scrollTop: 36 * 2_500,
      overscan: 8,
    });
    expect(window.end - window.start).toBeLessThan(50);
  });
});
