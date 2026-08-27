import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ATTRIBUTE_PREFIX,
  MAX_XML_BYTES,
  TEXT_KEY,
  XmlError,
  looksLikeXml,
  parseXml,
} from '../src/support/xml.js';

/**
 * XML into a tree (`T-24`).
 *
 * The shape assertions are the point of this file. A path language reads whatever the parser
 * produced, so "every element is an array" and "an attribute is not" are not parser trivia —
 * they are the contract every path an operator writes depends on, and a settings change on an
 * upgrade would break every one of them at once, silently.
 */

const PRTG = `<?xml version="1.0" encoding="UTF-8"?>
<prtg>
  <result>
    <channel>Free Space</channel>
    <value>91.5</value>
    <unit state="ok">%</unit>
  </result>
  <result>
    <channel>Inodes</channel>
    <value>4000</value>
    <unit state="bad">Count</unit>
  </result>
  <text>looks fine</text>
</prtg>`;

/**
 * The one child element named `name`, as an object.
 *
 * Every element in the tree is an array — that is the contract these tests exist to pin — so
 * reaching one always means indexing, and doing it in one asserted place keeps the assertions
 * below about the shape rather than about unwrapping.
 */
function child(node: unknown, name: string): Record<string, unknown> {
  assert.ok(node !== null && typeof node === 'object', `${name}: the parent is not an object`);
  const found = (node as Record<string, unknown>)[name];
  assert.ok(Array.isArray(found), `<${name}> is not an array in the tree`);
  const one: unknown = found[0];
  assert.ok(one !== null && typeof one === 'object', `<${name}> is not an element`);
  return one as Record<string, unknown>;
}

/** Every child element named `name`, unwrapped from the array each one is. */
function children(node: unknown, name: string): unknown[] {
  assert.ok(node !== null && typeof node === 'object', `${name}: the parent is not an object`);
  const found = (node as Record<string, unknown>)[name];
  assert.ok(Array.isArray(found), `<${name}> is not an array in the tree`);
  return found;
}

describe('the shape of the tree', () => {
  it('makes every element an array, so one entry and many have the same shape', () => {
    // The failure this prevents is the nastiest kind: a path works for months and breaks the
    // morning the document happens to carry a single <result>.
    const one = parseXml('<prtg><result><value>1</value></result></prtg>');
    const two = parseXml(
      '<prtg><result><value>1</value></result><result><value>2</value></result></prtg>',
    );
    assert.equal(children(child(one, 'prtg'), 'result').length, 1);
    assert.equal(children(child(two, 'prtg'), 'result').length, 2);
  });

  it('does not make an attribute an array, because an attribute is single-valued', () => {
    const tree = parseXml('<a><b state="ok">x</b></a>');
    const b = child(child(tree, 'a'), 'b');
    assert.equal(b[`${ATTRIBUTE_PREFIX}state`], 'ok');
    assert.equal(b[TEXT_KEY], 'x');
  });

  it('keeps an attribute and a child element of the same name apart', () => {
    // Merging them would make one of the two unreachable, and which one would depend on parse
    // order — a document-dependent disappearance is worse than either choice.
    const tree = parseXml('<r name="attr"><name>child</name></r>');
    const r = child(tree, 'r');
    assert.equal(r[`${ATTRIBUTE_PREFIX}name`], 'attr');
    assert.deepEqual(r['name'], ['child']);
  });

  it('leaves numbers as strings, so 007 and 1.10 survive', () => {
    // There is one place in this system that decides what a string means, and it is the path
    // module's numberFrom — which is also what reads a JSON API's quoted gauges.
    const tree = parseXml('<a><v>007</v><w>1.10</w></a>');
    const a = child(tree, 'a');
    assert.deepEqual(a['v'], ['007']);
    assert.deepEqual(a['w'], ['1.10']);
  });

  it('keeps namespace prefixes', () => {
    // <soap:Body> and <Body> are not the same element, and they differ precisely in the
    // documents where namespaces carry meaning.
    const tree = parseXml(
      '<soap:Envelope xmlns:soap="http://x"><soap:Body>1</soap:Body></soap:Envelope>',
    );
    assert.ok('soap:Body' in child(tree, 'soap:Envelope'));
  });

  it('reads CDATA and character entities as text', () => {
    const tree = parseXml('<a><b><![CDATA[1 < 2]]></b><c>a &amp; b</c></a>');
    const a = child(tree, 'a');
    assert.deepEqual(a['b'], ['1 < 2']);
    assert.deepEqual(a['c'], ['a & b']);
  });

  it('reads the PRTG document a script actually prints', () => {
    const tree = parseXml(PRTG);
    const prtg = child(tree, 'prtg');
    assert.equal(children(prtg, 'result').length, 2);
    assert.deepEqual(prtg['text'], ['looks fine']);
  });
});

describe('what it refuses', () => {
  it('refuses a truncated document rather than building a tree from half of it', () => {
    // The case a monitoring check meets most often — a response cut off by a bound or a dropped
    // connection. fast-xml-parser is lenient by design and would parse this, and a tree from
    // half a document is the confidently-wrong number this whole module exists to avoid.
    assert.throws(
      () => parseXml('<prtg><result><value>91.5</value>'),
      (error: unknown) => error instanceof XmlError && /not well-formed/.test(error.message),
    );
  });

  it('refuses mismatched tags and names the line', () => {
    assert.throws(() => parseXml('<a>\n<b>1</c>\n</a>'), /line 2/);
  });

  it('refuses an empty response and one over the bound', () => {
    assert.throws(() => parseXml('   '), /was empty/);
    assert.throws(() => parseXml(`<a>${'x'.repeat(MAX_XML_BYTES)}</a>`), /the limit is/);
  });
});

describe('external entities, which are the reason to be careful here', () => {
  it('does not expand a billion laughs', () => {
    // Nine nested entities, each ten of the one below: expanded, this is 10^9 characters and the
    // process is gone. No DTD-declared entity is expanded at all — the reference survives as the
    // literal text `&lol8;` — and this asserts it, because a defence nobody checks is one that
    // disappears quietly on an upgrade.
    const entities = Array.from({ length: 9 }, (_unused, at) =>
      at === 0
        ? '<!ENTITY lol "lol">'
        : `<!ENTITY lol${String(at)} "${`&lol${at === 1 ? '' : String(at - 1)};`.repeat(10)}">`,
    ).join('\n');
    const bomb = `<?xml version="1.0"?>\n<!DOCTYPE lolz [\n${entities}\n]>\n<lolz>&lol8;</lolz>`;

    const before = process.memoryUsage().heapUsed;
    let text = '';
    try {
      const tree = parseXml(bomb);
      text = JSON.stringify(tree);
    } catch (error) {
      assert.ok(error instanceof XmlError, 'refusing it outright is also a correct answer');
    }
    assert.ok(text.length < 10_000, `the document did not expand (${String(text.length)} bytes)`);
    assert.ok(process.memoryUsage().heapUsed - before < 100e6, 'no memory was eaten');
  });

  it('does not read a file through a SYSTEM entity', () => {
    // Refused outright, which is the strongest of the three answers. `XmlError` rather than the
    // library's own is the point of the second assertion: callers catch `XmlError`, so a bare
    // library throw here would surface as an unclassified failure with no sensor and no target
    // in it. That is how this was found.
    const attack =
      '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>';
    let text = '';
    try {
      text = JSON.stringify(parseXml(attack));
    } catch (error) {
      assert.ok(error instanceof XmlError, `a library error escaped: ${String(error)}`);
    }
    assert.ok(!/root:/.test(text), 'no local file was read into the tree');
  });

  it('does not fetch a URL through an external entity', () => {
    // No network call to intercept, because the parser makes none — asserted by the absence of
    // the content and by this returning at all rather than waiting on a socket.
    const attack =
      '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "http://127.0.0.1:1/secret">]>\n<r>&x;</r>';
    let text = '';
    try {
      text = JSON.stringify(parseXml(attack));
    } catch (error) {
      assert.ok(error instanceof XmlError, `a library error escaped: ${String(error)}`);
    }
    assert.ok(!/secret/.test(text));
  });
});

describe('looksLikeXml', () => {
  it('believes the content type first', () => {
    assert.equal(looksLikeXml('<a/>', 'application/xml'), true);
    assert.equal(looksLikeXml('<a/>', 'text/xml; charset=utf-8'), true);
    assert.equal(looksLikeXml('<a/>', 'application/soap+xml'), true);
    assert.equal(looksLikeXml('<a/>', 'application/atom+xml'), true);
  });

  it('falls back to the body when the server says application/octet-stream', () => {
    assert.equal(looksLikeXml('<?xml version="1.0"?><a/>', 'application/octet-stream'), true);
    assert.equal(looksLikeXml('  \n<prtg><result/></prtg>', ''), true);
  });

  it('does not mistake JSON for XML', () => {
    assert.equal(looksLikeXml('{"ok":true}', 'application/json'), false);
    assert.equal(looksLikeXml('', ''), false);
  });

  it('does not mistake an HTML page for XML, however it is spelt', () => {
    // The one that matters, and the one the first version of this got wrong. A proxy or a login
    // page is well-formed enough to parse as XML, and a document that *parses* turns "this is
    // not an API response" into "your path matched nothing in it" — the worse diagnosis, and
    // the one an operator cannot act on.
    for (const [body, type] of [
      ['<!DOCTYPE html><html><body>502</body></html>', 'text/html'],
      ['<html><body>not an api</body></html>', 'text/html'],
      ['<html><body>not an api</body></html>', ''],
      ['\n  <HTML><BODY>gateway timeout</BODY></HTML>', 'application/octet-stream'],
    ] as const) {
      assert.equal(looksLikeXml(body, type), false, `${type}: ${body.slice(0, 30)}`);
    }
  });

  it('believes a declaration over a content type that contradicts it', () => {
    // XML served as application/json is a real misconfiguration, and not a rare one.
    assert.equal(looksLikeXml('<?xml version="1.0"?><a/>', 'application/json'), true);
  });
});
