import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { restCustom } from '../src/types/rest-custom.js';
import type { CheckContext, CheckExecution } from '../src/contract.js';

/**
 * The REST sensor against a server that answers like the APIs it is for.
 *
 * The path language has its own file; what is asserted here is what a sensor does with what a
 * path found — the channels, the gaps, the failures, and the ones that are not faults.
 */

let server: Server;
let port = 0;
let lastHeaders: IncomingHttpHeaders = {};
let lastMethod = '';
let lastBody = '';

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

before(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    lastMethod = req.method ?? '';
    lastBody = '';
    req.on('data', (chunk: Buffer) => {
      lastBody += chunk.toString('utf8');
    });
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url === '/cluster') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(CLUSTER));
        return;
      }
      if (url === '/degraded') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...CLUSTER, status: 'degraded' }));
        return;
      }
      if (url === '/empty') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nodes: [] }));
        return;
      }
      if (url === '/html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>not an api</body></html>');
        return;
      }
      if (url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pad: 'y'.repeat(20_000), n: 1 }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

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
    assert.equal(lastMethod, 'POST');
    assert.equal(lastBody, '{"query":"depth"}');
    assert.equal(lastHeaders['content-type'], 'application/json');
    assert.equal(lastHeaders['authorization'], 'Bearer sekrit');
  });
});
