import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { HttpSimulator, type RecordedRequest } from '@ms/simulators';
import { SensorCatalogue } from '../src/catalogue.js';
import { REST_OWN_KEYS, restCustom } from '../src/types/rest-custom.js';
import type { CheckContext, CheckExecution, PreviewResult, PreviewRow } from '../src/contract.js';

/**
 * The REST sensor against a server that answers like the APIs it is for.
 *
 * The path language has its own file; what is asserted here is what a sensor does with what a
 * path found — the channels, the gaps, the failures, and the ones that are not faults.
 */

let http: HttpSimulator;
let port = 0;

const JSON_TYPE = { 'content-type': 'application/json' };

const CLUSTER = {
  status: 'healthy',
  version: '4.2.1',
  queue: { depth: 12, oldest: '4.5' },
  nodes: [
    { name: 'a', state: 'up', load: 0.4 },
    { name: 'b', state: 'down', load: 0.95 },
    { name: 'c', state: 'down', load: 0.7 },
  ],
};

/** The same cluster, from the sort of appliance that answers in XML. */
const CLUSTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cluster>
  <status>healthy</status>
  <queue depth="12"><oldest unit="s">4.5</oldest></queue>
  <node name="a" state="up"><load>0.4</load></node>
  <node name="b" state="down"><load>0.95</load></node>
  <node name="c" state="down"><load>0.7</load></node>
</cluster>`;

before(async () => {
  // **The harness rather than a hand-rolled server** (`P-06`). What this file needs from a server
  // is a dozen static bodies under chosen content types, and expressing that as a chain of
  // `if (url === …)` blocks was thirty lines that said nothing about the REST sensor. What is
  // left is the table, which is the part worth reading.
  http = new HttpSimulator({
    routes: {
      '/cluster': { headers: JSON_TYPE, body: JSON.stringify(CLUSTER) },
      '/degraded': {
        headers: JSON_TYPE,
        body: JSON.stringify({ ...CLUSTER, status: 'degraded' }),
      },
      '/empty': { headers: JSON_TYPE, body: JSON.stringify({ nodes: [] }) },
      '/html': {
        headers: { 'content-type': 'text/html' },
        body: '<html><body>not an api</body></html>',
      },
      '/cluster.xml': { headers: { 'content-type': 'application/xml' }, body: CLUSTER_XML },
      // The case `auto` exists for: an appliance serving XML as octet-stream, which is commoner
      // than it should be.
      '/cluster.xml-untyped': {
        headers: { 'content-type': 'application/octet-stream' },
        body: CLUSTER_XML,
      },
      // A misconfiguration that exists in the field: XML under a JSON content type.
      '/xml-mislabelled': { headers: JSON_TYPE, body: CLUSTER_XML },
      '/truncated.xml': {
        headers: { 'content-type': 'application/xml' },
        body: '<cluster><node><load>0.4</load>',
      },
      '/big': { headers: JSON_TYPE, body: JSON.stringify({ pad: 'y'.repeat(20_000), n: 1 }) },
    },
    fallback: { status: 404, headers: JSON_TYPE, body: '{}' },
  });
  port = await http.start();
});

after(async () => {
  await http.stop();
});

/** The last request the simulator saw, which is what the assertions about headers read. */
function lastRequest(): RecordedRequest {
  const request = http.requests.at(-1);
  assert.ok(request !== undefined, 'no request reached the server');
  return request;
}

function run(
  params: Record<string, unknown>,
  over: Partial<CheckContext> = {},
): Promise<CheckExecution> {
  return restCustom.execute({
    sensorId: 1,
    target: { host: '127.0.0.1', ipVersion: 'v4' },
    params: { scheme: 'http', port, timeoutMs: 5_000, path: '/cluster', ...params },
    credentials: {},
    signal: new AbortController().signal,
    ...over,
  });
}

const valueOf = (execution: CheckExecution, key: string): number | undefined =>
  execution.channels.find((channel) => channel.key === key)?.value;

describe('rest.custom', () => {
  it('turns paths into channels', async () => {
    const execution = await run({
      extract: [
        { key: 'depth', name: 'Queue depth', unit: 'jobs', path: '$.queue.depth' },
        {
          key: 'down',
          name: 'Nodes down',
          path: "$.nodes[?(@.state=='down')]",
          aggregate: 'count',
        },
        { key: 'worst', name: 'Worst load', unit: '%', path: '$.nodes[*].load', aggregate: 'max' },
      ],
    });
    assert.equal(valueOf(execution, 'depth'), 12);
    assert.equal(valueOf(execution, 'down'), 2);
    assert.equal(valueOf(execution, 'worst'), 0.95);
    assert.ok((valueOf(execution, 'responseTime') ?? -1) >= 0);
    assert.match(execution.message ?? '', /depth=12 down=2 worst=0\.95/);
  });

  it('scales a value the API reports in the wrong unit', async () => {
    const execution = await run({
      extract: [{ key: 'worst', path: '$.nodes[*].load', aggregate: 'max', scale: 100 }],
    });
    assert.equal(valueOf(execution, 'worst'), 95);
  });

  it('makes the first mapping the channel the sensor is judged by', () => {
    const defs = restCustom.channels({
      extract: [
        { key: 'depth', path: '$.queue.depth' },
        { key: 'down', path: '$.nodes' },
      ],
    });
    assert.deepEqual(
      defs.filter((def) => def.isPrimary === true).map((def) => def.key),
      ['depth'],
    );
    // Response time is still there, last: an API that answers correctly in four seconds is a
    // fault, and nothing in its own numbers says so.
    assert.equal(defs[defs.length - 1]?.key, 'responseTime');
  });

  it('gaps a channel whose path found nothing, rather than reporting zero', async () => {
    const execution = await run({
      extract: [
        { key: 'depth', path: '$.queue.depth' },
        { key: 'gone', path: '$.queue.retired' },
      ],
    });
    assert.equal(valueOf(execution, 'depth'), 12);
    assert.equal(valueOf(execution, 'gone'), undefined);
    assert.match(execution.message ?? '', /gone found nothing/);
  });

  it('reports a real zero from count, because none of something is a reading', async () => {
    // The distinction the aggregate exists to make. "No nodes are down" is data; "the depth
    // field is gone" is not, and one channel cannot say both.
    const execution = await run({
      path: '/empty',
      extract: [{ key: 'down', path: "$.nodes[?(@.state=='down')]", aggregate: 'count' }],
    });
    assert.equal(valueOf(execution, 'down'), 0);
  });

  it('fails when nothing at all matched, which is a sensor pointed at the wrong document', async () => {
    await assert.rejects(
      () => run({ extract: [{ key: 'x', path: '$.nothing.here' }] }),
      /none of this sensor’s 1 paths matched anything.*\$\.nothing\.here/s,
    );
  });

  it('checks a status field as text, where a channel would lose what it said', async () => {
    const execution = await run({
      extract: [{ key: 'depth', path: '$.queue.depth' }],
      expect: [{ path: '$.status', equals: 'healthy' }],
    });
    assert.equal(valueOf(execution, 'depth'), 12);

    await assert.rejects(
      () =>
        run({
          path: '/degraded',
          extract: [{ key: 'depth', path: '$.queue.depth' }],
          expect: [{ path: '$.status', equals: 'healthy' }],
        }),
      /\$\.status is "degraded" and should be "healthy"/,
    );
  });

  it('says when an expected value is not in the response at all', async () => {
    await assert.rejects(
      () =>
        run({
          extract: [{ key: 'depth', path: '$.queue.depth' }],
          expect: [{ path: '$.build.number', contains: '4.2' }],
        }),
      /\$\.build\.number is not in the response/,
    );
  });

  it('refuses a path it cannot run before making the request', async () => {
    // At save time this is a validation error; at check time it should still name the channel
    // rather than blame the network.
    await assert.rejects(
      () => run({ port: 1, extract: [{ key: 'x', path: '$.nodes[0' }] }),
      /channel "x": .*never closed/,
    );
  });

  it('says the response was not JSON, and what it claimed to be', async () => {
    await assert.rejects(
      () => run({ path: '/html', extract: [{ key: 'x', path: '$.a' }] }),
      /the response is not JSON.*Content-Type: text\/html/s,
    );
  });

  it('fails rather than truncating a response bigger than it reads', async () => {
    // Half a JSON document does not parse at all, and "unexpected end of input" is a worse
    // diagnosis than the size.
    await assert.rejects(
      () => run({ path: '/big', maxBodyBytes: 2_048, extract: [{ key: 'n', path: '$.n' }] }),
      /larger than the 2048 bytes this sensor reads/,
    );
  });

  it('sends the method, body and credential it was given', async () => {
    await run(
      {
        method: 'POST',
        body: '{"query":"depth"}',
        requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        extract: [{ key: 'depth', path: '$.queue.depth' }],
      },
      { credentials: { http: { token: 'sekrit' } } },
    );
    const request = lastRequest();
    assert.equal(request.method, 'POST');
    assert.equal(request.body, '{"query":"depth"}');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['authorization'], 'Bearer sekrit');
  });

  describe('XML, which is what the appliances answer in', () => {
    it('reads an XPath into a channel', async () => {
      const execution = await run({
        path: '/cluster.xml',
        extract: [
          { key: 'depth', name: 'Queue depth', unit: 'jobs', path: '/cluster/queue/@depth' },
          { key: 'worst', name: 'Worst load', path: '/cluster/node/load', aggregate: 'max' },
          { key: 'nodes', name: 'Nodes', path: '/cluster/node', aggregate: 'count' },
        ],
      });
      assert.equal(valueOf(execution, 'depth'), 12);
      assert.equal(valueOf(execution, 'worst'), 0.95);
      assert.equal(valueOf(execution, 'nodes'), 3);
    });

    it('counts with a predicate, which is the XML spelling of the JSON filter above', async () => {
      const execution = await run({
        path: '/cluster.xml',
        extract: [{ key: 'down', path: "/cluster/node[@state='down']", aggregate: 'count' }],
      });
      assert.equal(valueOf(execution, 'down'), 2);
    });

    it('checks an expectation against XML the same way it does against JSON', async () => {
      await assert.rejects(
        () =>
          run({
            path: '/cluster.xml',
            extract: [{ key: 'depth', path: '/cluster/queue/@depth' }],
            expect: [{ path: '/cluster/status', equals: 'degraded' }],
          }),
        /is "healthy" and should be "degraded"/,
      );
    });

    it('detects XML the server did not label, because half of them do not', async () => {
      const execution = await run({
        path: '/cluster.xml-untyped',
        extract: [{ key: 'depth', path: '/cluster/queue/@depth' }],
      });
      assert.equal(valueOf(execution, 'depth'), 12);
    });

    it('parses what the operator says to parse, over what the server claims', async () => {
      // XML under a JSON content type is a misconfiguration that exists in the field, and the
      // operator can work around it here rather than waiting for somebody else to fix it.
      // `auto` gets this one right on its own — a declaration outranks the content type — so
      // what the override has to prove is that it is honoured in the direction where saying so
      // changes the answer.
      for (const format of ['auto', 'xml'] as const) {
        const execution = await run({
          path: '/xml-mislabelled',
          format,
          extract: [{ key: 'depth', path: '/cluster/queue/@depth' }],
        });
        assert.equal(valueOf(execution, 'depth'), 12, format);
      }
      await assert.rejects(
        () =>
          run({
            path: '/xml-mislabelled',
            format: 'json',
            extract: [{ key: 'depth', path: '/cluster/queue/@depth' }],
          }),
        /is not JSON:/,
      );
    });

    it('says which format it tried when the body is neither', async () => {
      await assert.rejects(
        () => run({ path: '/truncated.xml', extract: [{ key: 'n', path: '/cluster/node/load' }] }),
        /is not XML: this is not well-formed XML/,
      );
      await assert.rejects(
        () => run({ path: '/html', extract: [{ key: 'n', path: '$.n' }] }),
        /is not JSON:/,
        'an HTML error page is still not XML worth parsing',
      );
    });

    it('gaps rather than zeroing when an XPath finds nothing', async () => {
      // The rule the whole system is built on, and the one an XML path is most likely to break:
      // a path that misses reads as no data, never as zero.
      await assert.rejects(
        () =>
          run({
            path: '/cluster.xml',
            extract: [{ key: 'depth', path: '/cluster/missing/@depth' }],
          }),
        /none of this sensor’s 1 paths matched anything/,
      );
    });
  });
});

/**
 * The dry run behind `U-13`'s mapping editor.
 *
 * **The property worth testing is agreement, not correctness.** What each path selects is
 * `json-path`'s business and is covered there; what matters here is that the preview and a real
 * check reach the *same* number from the same document — because the whole value of the editor
 * is that a path proved against a pasted response then works against the device. So most of what
 * follows runs both halves and compares them.
 */
describe('previewing against a pasted response', () => {
  /** `preview` is optional on the contract, so every case goes through this. */
  const preview = (
    params: Record<string, unknown>,
    document = JSON.stringify(CLUSTER),
    contentType = 'application/json',
  ): Promise<PreviewResult> => {
    assert.ok(restCustom.preview !== undefined, 'rest.custom declares no preview');
    return restCustom.preview({ document, contentType, params });
  };

  const rowFor = (result: PreviewResult, key: string): PreviewRow => {
    const row = result.rows.find((one) => one.key === key);
    assert.ok(row !== undefined, `no row for ${key}`);
    return row;
  };

  it('reaches the same numbers a real check reaches, for every aggregate', async () => {
    // The differential test, and the reason the preview calls the sensor's own functions rather
    // than reimplementing the walk. A preview that agreed most of the time would be worse than
    // none: it would certify a path that does not work.
    const extract = [
      { key: 'depth', path: '$.queue.depth' },
      { key: 'oldest', path: '$.queue.oldest' },
      { key: 'down', path: "$.nodes[?(@.state=='down')]", aggregate: 'count' },
      { key: 'worst', path: '$.nodes[*].load', aggregate: 'max' },
      { key: 'mean', path: '$.nodes[*].load', aggregate: 'avg' },
      { key: 'total', path: '$..load', aggregate: 'sum' },
      { key: 'scaled', path: '$.nodes[0].load', scale: 100 },
    ];

    const execution = await run({ extract });
    const previewed = await preview({ extract });

    for (const mapping of extract) {
      assert.equal(
        rowFor(previewed, mapping.key).value,
        valueOf(execution, mapping.key),
        `${mapping.key} disagrees`,
      );
    }
  });

  it('shows what a path selected, not only what it became', async () => {
    // The question the editor exists to answer. "$.nodes[*].load selected three values and the
    // worst is 0.95" is what makes a path believable; a bare number is not.
    const result = await preview({
      extract: [{ key: 'worst', path: '$.nodes[*].load', aggregate: 'max' }],
    });
    const row = rowFor(result, 'worst');
    assert.equal(row.selectedCount, 3);
    assert.deepEqual(
      row.selected.map((one) => one.text),
      ['0.4', '0.95', '0.7'],
    );
    assert.equal(row.value, 0.95);
  });

  it('says which selected values an aggregate can actually use', async () => {
    // The commonest confusion this feature exists to end: a path selects five things, the reading
    // is a gap, and nothing about the values as printed says why. `oldest` is the string "4.5",
    // which *is* usable; a name is not.
    const result = await preview({
      extract: [
        { key: 'names', path: '$.nodes[*].name' },
        { key: 'oldest', path: '$.queue.oldest' },
      ],
    });
    assert.deepEqual(
      rowFor(result, 'names').selected.map((one) => one.numeric),
      [false, false, false],
    );
    assert.equal(rowFor(result, 'names').value, null, 'three strings make no reading');
    assert.equal(rowFor(result, 'oldest').selected[0]?.numeric, true, '"4.5" is a number');
    assert.equal(rowFor(result, 'oldest').value, 4.5);
  });

  it('reports a mistyped path on its own row and answers the others anyway', async () => {
    // The state this form is in every few keystrokes. `execute` fails the whole check on a bad
    // path, correctly — a sensor with one is broken — but a preview that went blank while
    // somebody typed would be useless exactly when it is being used.
    const result = await preview({
      extract: [
        { key: 'broken', path: '$.nodes[?(@.state' },
        { key: 'depth', path: '$.queue.depth' },
      ],
    });
    assert.ok(rowFor(result, 'broken').error !== undefined);
    assert.equal(rowFor(result, 'broken').value, null);
    assert.equal(rowFor(result, 'depth').value, 12, 'the neighbour still answers');
    assert.ok(result.problems.some((one) => one.includes('broken')));
  });

  it('does not add "nothing matched" on top of a path that did not parse', async () => {
    // Found by driving the real form: a single mistyped path produced *two* problems, and the
    // second — "none of these 1 paths matched anything in this response" — is one `execute`
    // would never report, because it compiles every path before it sends the request. It also
    // sends somebody looking at their document when the problem is a bracket.
    const result = await preview({ extract: [{ key: 'only', path: '$.nodes[?(@.load' }] });
    assert.equal(result.problems.length, 1, result.problems.join(' | '));
    assert.match(result.problems[0] ?? '', /never closed/);
  });

  it('still says nothing matched when the paths are fine and the document is wrong', async () => {
    const result = await preview({
      extract: [
        { key: 'a', path: '$.missing' },
        { key: 'b', path: "$.nodes[?(@.state=='nowhere')]" },
      ],
    });
    assert.ok(result.problems.some((one) => one.includes('none of these 2 paths')));
  });

  it('names the format it read the document as', async () => {
    // `auto` is a guess, and a preview that did not say which way it went would leave an operator
    // writing JSONPath against a document this parsed as XML.
    assert.equal((await preview({ extract: [] })).format, 'json');
    assert.equal(
      (await preview({ extract: [] }, CLUSTER_XML, 'application/octet-stream')).format,
      'xml',
      'the appliance serving XML as octet-stream, which is what auto is for',
    );
    assert.equal(
      (await preview({ extract: [], format: 'json' }, CLUSTER_XML, 'application/xml')).format,
      'json',
      'an explicit format is not overridden by what the document looks like',
    );
  });

  it('lets the pasted Content-Type decide where the document alone cannot', async () => {
    // The case the field is *for*, and the only one where it changes the answer: a fragment
    // starting with `<` looks like XML to the guess, and `text/html` is what says it is an error
    // page rather than data. A preview that dropped the header would read one as the other.
    const fragment = '<div>hello</div>';
    assert.equal((await preview({ extract: [] }, fragment, '')).format, 'xml');

    const asHtml = await preview({ extract: [] }, fragment, 'text/html; charset=utf-8');
    assert.equal(asHtml.format, 'json');
    assert.match(asHtml.error ?? '', /not JSON/);
  });

  it('reads XPath against XML, and agrees with a check that did', async () => {
    const extract = [
      { key: 'depth', path: '/cluster/queue/@depth' },
      { key: 'worst', path: '/cluster/node/load', aggregate: 'max' },
    ];
    const execution = await run({ path: '/cluster.xml', extract });
    const previewed = await preview({ extract }, CLUSTER_XML, 'application/xml');

    assert.equal(previewed.format, 'xml');
    assert.equal(rowFor(previewed, 'depth').value, valueOf(execution, 'depth'));
    assert.equal(rowFor(previewed, 'worst').value, valueOf(execution, 'worst'));
  });

  it('says the document did not parse, rather than reporting every path as missing', async () => {
    // The difference matters: "none of your paths matched" sends somebody to rewrite paths that
    // were right, when what they pasted was an HTML error page.
    const result = await preview({ extract: [{ key: 'n', path: '$.n' }] }, '<html>nope</html>');
    assert.ok(result.error !== undefined);
    assert.match(result.error, /not JSON/);
    assert.deepEqual(result.rows, []);
  });

  it('reports the check-level failure a set of empty paths would be', async () => {
    // `execute`'s own rule: every path finding nothing is not a set of gaps, it is a sensor
    // pointed at the wrong document.
    const result = await preview({
      extract: [
        { key: 'a', path: '$.missing' },
        { key: 'b', path: '$.absent' },
      ],
    });
    assert.deepEqual(
      result.rows.map((row) => row.value),
      [null, null],
    );
    assert.ok(result.problems.some((one) => one.includes('none of these 2 paths')));
  });

  it('leaves a single missing path as a gap, because that is what it is', async () => {
    const result = await preview({
      extract: [
        { key: 'depth', path: '$.queue.depth' },
        { key: 'gone', path: '$.queue.removed' },
      ],
    });
    assert.equal(rowFor(result, 'gone').value, null);
    assert.equal(rowFor(result, 'gone').selectedCount, 0);
    assert.deepEqual(result.problems, [], 'one channel with no data is not a failure');
  });

  it('checks the expected values too, since a wrong one fails the check whatever the channels say', async () => {
    const result = await preview({
      extract: [{ key: 'depth', path: '$.queue.depth' }],
      expect: [
        { path: '$.status', equals: 'healthy' },
        { path: '$.version', contains: '9.' },
        { path: '$.missing', equals: 'anything' },
      ],
    });
    assert.equal(rowFor(result, 'depth').value, 12, 'the channels still read');
    assert.deepEqual(
      result.expectations.map((one) => one.ok),
      [true, false, false],
    );
    assert.equal(result.expectations[1]?.actual, '4.2.1');
    assert.ok(result.problems.some((one) => one.includes('$.version')));
    assert.ok(result.problems.some((one) => one.includes('$.missing is not in this response')));
  });

  it('bounds what it sends back, and says how many there really were', async () => {
    // A wildcard over a large document selects more than anybody reads, and the whole document
    // coming back one value at a time would be a worse way to send it than sending it.
    const many = { rows: Array.from({ length: 40 }, (_v, i) => ({ v: i })) };
    const result = await preview(
      { extract: [{ key: 'all', path: '$.rows[*].v', aggregate: 'count' }] },
      JSON.stringify(many),
    );
    const row = rowFor(result, 'all');
    assert.equal(row.selectedCount, 40, 'the count is honest');
    assert.equal(row.selected.length, 10, 'what comes back is not');
    assert.equal(row.value, 40, 'and the reading is of all of them');
  });

  it('truncates a selected value rather than returning a document inside a field', async () => {
    const long = { note: 'x'.repeat(5_000) };
    const result = await preview(
      { extract: [{ key: 'note', path: '$.note' }] },
      JSON.stringify(long),
    );
    const text = rowFor(result, 'note').selected[0]?.text ?? '';
    assert.ok(text.length < 250, `sent back ${String(text.length)} characters`);
    assert.ok(text.endsWith('…'), 'and says it was cut');
  });

  it('answers a half-filled form without throwing, which is its normal state', async () => {
    // Everything the editor sends before the operator has finished: no rows, a row with no path,
    // a row with no key. None of these is an error worth refusing a preview over.
    for (const params of [
      {},
      { extract: [] },
      { extract: [{ key: 'a' }] },
      { extract: [{ path: '$.queue.depth' }] },
      { extract: 'not even an array' },
    ]) {
      const result = await preview(params);
      assert.ok(Array.isArray(result.rows), `${JSON.stringify(params)} threw or answered wrongly`);
    }
  });
});

describe('an extract key (P-348)', () => {
  const catalogue = new SensorCatalogue().register(restCustom).seal();
  const withKey = (key: string): Record<string, unknown> => ({
    path: '/cluster',
    extract: [{ key, path: '$.latency' }],
  });

  it('names exactly the key the sensor reports of its own', () => {
    // `{}` declares it alone, as the primary; with mappings it comes after them.
    assert.deepEqual(
      restCustom.channels({}).map((def) => def.key),
      [...REST_OWN_KEYS],
    );
    const own = restCustom
      .channels({ extract: [{ key: 'depth', path: '$.queue.depth' }] })
      .map((def) => def.key)
      .filter((key) => key !== 'depth');
    assert.deepEqual(own, [...REST_OWN_KEYS]);
  });

  for (const key of REST_OWN_KEYS) {
    it(`refuses "${key}", the sensor's own channel`, () => {
      const outcome = catalogue.validate(restCustom.id, withKey(key));
      assert.ok(!outcome.valid, key);
      assert.deepEqual(
        outcome.problems.map((problem) => problem.path),
        ['/extract/0/key'],
      );
    });
  }

  it('still takes a key that only resembles it, declared once', () => {
    for (const key of ['ResponseTime', 'responseTime2', 'response_time', 'responseTime.p95']) {
      const outcome = catalogue.validate(restCustom.id, withKey(key));
      assert.ok(outcome.valid, key);
      const keys = catalogue.channelsFor(restCustom.id, outcome.params).map((def) => def.key);
      assert.equal(keys.filter((one) => one === key).length, 1, key);
      assert.equal(new Set(keys).size, keys.length, key);
    }
  });
});
