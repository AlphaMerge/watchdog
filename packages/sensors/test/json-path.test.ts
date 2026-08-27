import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  aggregateOf,
  JsonPathError,
  parsePath,
  selectPath,
  type Aggregate,
} from '../src/support/json-path.js';

/**
 * The path language, on its own.
 *
 * Pure and separate from the sensor because this is the half that is easy to get subtly wrong:
 * a path that selects one value too few is a channel that quietly reads the wrong number, and
 * nothing downstream can tell.
 */

const DOCUMENT = {
  status: 'healthy',
  queue: { depth: 12, oldest: '4.5' },
  nodes: [
    { name: 'a', state: 'up', load: 0.4, disk: { free: 900 } },
    { name: 'b', state: 'down', load: 0.95, disk: { free: 20 } },
    { name: 'c', state: 'down', load: 0.7, disk: { free: 40 } },
  ],
  counts: { ok: 1, warn: 2, error: 3 },
  regions: { east: { free: 1 }, west: { free: 2 } },
};

const at = (path: string, document: unknown = DOCUMENT): unknown[] =>
  selectPath(document, parsePath(path));

const value = (path: string, how: Aggregate = 'first'): number | null => aggregateOf(at(path), how);

describe('paths', () => {
  it('reads a member, with or without the root', () => {
    assert.deepEqual(at('$.queue.depth'), [12]);
    assert.deepEqual(at('queue.depth'), [12]);
    assert.deepEqual(at("$['queue']['depth']"), [12]);
  });

  it('reads an index, and counts backwards from the end', () => {
    assert.deepEqual(at('$.nodes[0].name'), ['a']);
    assert.deepEqual(at('$.nodes[-1].name'), ['c']);
    assert.deepEqual(at('$.nodes[9].name'), []);
  });

  it('reads every element of an array and every value of an object', () => {
    assert.deepEqual(at('$.nodes[*].load'), [0.4, 0.95, 0.7]);
    assert.deepEqual(at('$.counts.*'), [1, 2, 3]);
  });

  it('descends to a name at any depth, in document order', () => {
    // The whole point of `..` — an API that nests one level deeper after an upgrade does not
    // break every channel written against it.
    // Across sibling object keys as well as array elements: `regions` comes after `nodes` in
    // the document, and `east` before `west` inside it.
    assert.deepEqual(at('$..free'), [900, 20, 40, 1, 2]);
    assert.deepEqual(at('$..depth'), [12]);
  });

  it('filters on a comparison', () => {
    assert.deepEqual(at("$.nodes[?(@.state=='down')].name"), ['b', 'c']);
    assert.deepEqual(at('$.nodes[?(@.load>0.5)].name'), ['b', 'c']);
    assert.deepEqual(at("$.nodes[?(@.state!='down')].name"), ['a']);
    assert.deepEqual(at('$.nodes[?(@.load<=0.4)].name'), ['a']);
  });

  it('reaches into a filtered field, and tolerates the parentheses being left off', () => {
    assert.deepEqual(at('$.nodes[?(@.disk.free<100)].name'), ['b', 'c']);
    assert.deepEqual(at("$.nodes[?@.state=='up'].name"), ['a']);
  });

  it('compares a number to a string without caring which the API sent', () => {
    // JSON carries "3" and 3 from the same field on different days, and an operator comparing to
    // 3 means both. A sensor that silently stopped matching after a serialiser change would be
    // reported as a network fault.
    assert.deepEqual(at("$.nodes[?(@.load=='0.4')].name"), ['a']);
    assert.deepEqual(at('$.counts[?(@==2)]'), [2]);
  });

  it('selects nothing rather than throwing when the document is a different shape', () => {
    assert.deepEqual(at('$.queue.depth', { other: 1 }), []);
    assert.deepEqual(at('$.nodes[0]', { nodes: 'not an array' }), []);
    assert.deepEqual(at('$.a.b.c', null), []);
  });

  it('refuses a path it cannot run, and says why', () => {
    assert.throws(() => parsePath(''), JsonPathError);
    assert.throws(() => parsePath('$'), /selects the whole document/);
    assert.throws(() => parsePath('$.nodes[0'), /never closed/);
    assert.throws(() => parsePath('$.nodes[?(@.state)]'), /is not a comparison/);
    assert.throws(() => parsePath('$..*'), /never a check/);
    assert.throws(() => parsePath(`$.${'a'.repeat(300)}`), /the limit is 200/);
  });

  it('refuses a filter that would evaluate an expression', () => {
    // Full JSONPath's `[?(...)]` runs JavaScript in the reference implementation. An
    // operator-supplied expression that can execute is a thing this codebase already refused
    // once, in the regex sandbox.
    assert.throws(() => parsePath('$.nodes[?(@.load.toString())]'), /is not a comparison/);
  });

  it('descends a document deeper than the call stack', () => {
    // The recursive version died at around 12,000 levels with "Maximum call stack size
    // exceeded", which tells an operator nothing about their sensor. A JSON document nests as
    // deeply as whatever produced it felt like.
    let deep: unknown = { load: -1 };
    for (let level = 0; level < 60_000; level += 1) deep = { child: deep, load: level };
    assert.equal(at('$..load', deep).length, 60_001);
  });

  it('bounds a descent rather than walking a document for ever', () => {
    let deep: unknown = { load: -1 };
    for (let level = 0; level < 250_000; level += 1) deep = { child: deep, load: level };
    assert.throws(() => at('$..load', deep), /visited more than 200000 values/);
  });
});

describe('aggregates', () => {
  it('counts what the path selected, not what was a number', () => {
    // "How many nodes are down" counts objects. Every other aggregate is about numbers, and
    // conflating the two makes both of them wrong somewhere.
    assert.equal(value("$.nodes[?(@.state=='down')]", 'count'), 2);
    assert.equal(value('$.nodes[*].name', 'count'), 3);
    assert.equal(value('$.nodes[*].name', 'sum'), null);
  });

  it('takes the first, the last, the extremes and the mean', () => {
    assert.equal(value('$.nodes[*].load', 'first'), 0.4);
    assert.equal(value('$.nodes[*].load', 'last'), 0.7);
    assert.equal(value('$.nodes[*].load', 'min'), 0.4);
    assert.equal(value('$.nodes[*].load', 'max'), 0.95);
    assert.equal(value('$.nodes[*].load', 'sum'), 2.05);
    assert.equal(Math.round((value('$.nodes[*].load', 'avg') ?? 0) * 1000), 683);
  });

  it('reads a number an API sent as a string', () => {
    // Half the world's REST endpoints do this, and refusing it would mean an operator whose
    // gauge is quoted cannot monitor it at all.
    assert.equal(value('$.queue.oldest'), 4.5);
  });

  it('gaps rather than zeroing when there is nothing to report', () => {
    // The rule the whole system is built on: no-data is not zero.
    assert.equal(value('$.missing.thing'), null);
    assert.equal(value('$.status'), null, 'a word is not a reading of none');
    assert.equal(value('$.missing.thing', 'count'), 0, 'except count, where none is a real zero');
  });

  it('reads a boolean as one or zero, because that is what a flag channel is', () => {
    assert.equal(aggregateOf([true, false, true], 'sum'), 2);
  });
});

/**
 * XPath spelling, over the same engine (`T-24`).
 *
 * A path beginning with `/` is read as a location path. There is one engine underneath, so what
 * these assert is the translation — and the one place the two syntaxes genuinely disagree, which
 * is where `[1]` points.
 */
describe('XPath location paths', () => {
  // The tree fast-xml-parser produces for the PRTG-shaped document in xml.test.ts: every
  // element an array, attributes prefixed, an element's own text under #text when it has
  // attributes too. Written out rather than parsed so this file stays pure.
  const XML = {
    prtg: [
      {
        result: [
          { channel: ['Free Space'], value: ['91.5'], unit: [{ '@_state': 'ok', '#text': '%' }] },
          { channel: ['Inodes'], value: ['4000'], unit: [{ '@_state': 'bad', '#text': 'Count' }] },
          { channel: ['Errors'], value: ['3'], unit: ['Count'] },
        ],
        text: ['looks fine'],
      },
    ],
  };

  const x = (path: string): unknown[] => at(path, XML);

  it('walks elements, flattening the array each one is', () => {
    // Without the flattening this returns [['91.5'], ['4000'], ['3']] and every aggregate over
    // it reports nothing — a path that looks right and silently measures no data.
    assert.deepEqual(x('/prtg/result/value'), ['91.5', '4000', '3']);
    assert.deepEqual(x('/prtg/result/channel'), ['Free Space', 'Inodes', 'Errors']);
  });

  it('counts positions from one, which is where the two syntaxes disagree', () => {
    // The reason the syntax decides rather than a setting: [1] meaning the second element to one
    // operator and the first to another, in the same field of the same form, is not a difference
    // anybody would find by reading their sensor.
    assert.deepEqual(x('/prtg/result[1]/value'), ['91.5']);
    assert.deepEqual(x('/prtg/result[2]/value'), ['4000']);
    assert.deepEqual(
      at('$.prtg[0].result[0].value', XML),
      [['91.5']],
      'JSONPath still counts from zero',
    );
    assert.throws(() => parsePath('/prtg/result[0]'), /positions start at 1/);
  });

  it('reads last(), because "the newest entry" is most of what anybody wants', () => {
    assert.deepEqual(x('/prtg/result[last()]/channel'), ['Errors']);
  });

  it('descends at any depth', () => {
    assert.deepEqual(x('//channel'), ['Free Space', 'Inodes', 'Errors']);
    assert.deepEqual(x('//text'), ['looks fine']);
  });

  it('reads an attribute', () => {
    assert.deepEqual(x('/prtg/result/unit/@state'), ['ok', 'bad']);
  });

  it("reads an element's own text, with attributes or without", () => {
    assert.deepEqual(x('/prtg/text/text()'), ['looks fine']);
    assert.deepEqual(x('/prtg/result[1]/unit/text()'), ['%'], 'past the attributes');
  });

  it('filters on a child element, reaching past its attributes to its text', () => {
    // <unit state="ok">%</unit> is an object in the tree, so comparing the node rather than its
    // string value would make this predicate silently false — a filter matching nothing looks
    // exactly like a document containing nothing.
    assert.deepEqual(x("/prtg/result[unit='%']/value"), ['91.5']);
    assert.deepEqual(x("/prtg/result[@state='ok']/value"), [], 'no such attribute on <result>');
  });

  it('filters on an attribute', () => {
    assert.deepEqual(x("/prtg/result/unit[@state='bad']/text()"), ['Count']);
  });

  it('compares numerically, on a document where every value is a string', () => {
    assert.deepEqual(x('/prtg/result[value>100]/channel'), ['Inodes']);
    assert.deepEqual(x('/prtg/result[value<100]/channel'), ['Free Space', 'Errors']);
  });

  it('selects nothing rather than something wrong when the path does not fit', () => {
    assert.deepEqual(x('/prtg/missing/value'), []);
    assert.deepEqual(x('/prtg/result[9]/value'), []);
    assert.equal(aggregateOf(x('/prtg/missing/value'), 'first'), null);
  });

  it('refuses the paths that would be a scan rather than a check', () => {
    assert.throws(() => parsePath('//*'), JsonPathError);
    assert.throws(() => parsePath('/'), /selects the whole document/);
    assert.throws(() => parsePath('/a[unclosed'), /never closed/);
    assert.throws(() => parsePath('/a[nonsense]'), /is not a predicate/);
  });

  it('aggregates an XPath selection the same way it aggregates a JSONPath one', () => {
    assert.equal(aggregateOf(x('/prtg/result/value'), 'sum'), 4094.5);
    assert.equal(aggregateOf(x('/prtg/result/value'), 'count'), 3);
    assert.equal(aggregateOf(x('/prtg/result/value'), 'max'), 4000);
  });
});
