import { strict as assert } from 'node:assert';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { after, describe, it } from 'node:test';
import {
  checkedTarget,
  nameLookups,
  RESOLVER_BUSY,
  RESOLVER_HELD,
  RESOLVER_LATE,
  type ResolvedAddress,
} from '@ms/sensors';
import type { ResolveRequest } from '../src/resolver/protocol.js';
import {
  ACK_LEAD_MS,
  ackWithinMs,
  PoolResolveClient,
  SETTLE_SLACK_MS,
} from '../src/runner/resolve-client.js';
import { pollWithin, within } from './support/within.js';

/**
 * A check worker's side of the probe's resolver (`P-426`), over a channel the test answers as the
 * main thread would, or does not.
 */

const A: readonly ResolvedAddress[] = [{ address: '192.0.2.10', family: 4 }];

const ports: MessagePort[] = [];
after(() => {
  for (const port of ports) port.close();
});

/** A client and the main thread's end of its port, whose requests the test sees. */
function channel(options: ConstructorParameters<typeof PoolResolveClient>[1] = {}) {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  const client = new PoolResolveClient(port1, options);
  const requests: ResolveRequest[] = [];
  port2.on('message', (request: ResolveRequest) => requests.push(request));
  /** The next request on the main thread's end, or a failure naming it within a second. */
  const next = async (): Promise<ResolveRequest> => {
    let request: ResolveRequest | undefined;
    await pollWithin(
      1_000,
      () => `a resolve request on the main thread’s port; ${String(requests.length)} queued`,
      () => {
        request = requests.shift();
        return request !== undefined;
      },
      5,
    );
    if (request === undefined) throw new Error('no resolve request');
    return request;
  };
  return { client, main: port2, next };
}

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe('a worker’s client of the probe’s resolver (P-426)', () => {
  it('asks over its port, and takes the answer by its id', async () => {
    const { client, main, next } = channel();
    const asked = client.resolve('a.test', 0, { waitMs: 2_000 });
    const request = await next();
    assert.deepEqual(request, {
      type: 'resolve',
      id: request.id,
      host: 'a.test',
      family: 0,
      waitMs: 2_000,
      fresh: false,
    });
    main.postMessage({ type: 'resolve-ack', id: request.id });
    main.postMessage({ type: 'resolved', id: request.id + 1, ok: true, addresses: [] });
    main.postMessage({ type: 'resolved', id: request.id, ok: true, addresses: A });
    assert.deepEqual(await asked, A);
    assert.equal(client.pending, 0);
  });

  it('keeps the resolver’s code on a failure', async () => {
    const { client, main, next } = channel();
    const asked = client.resolve('down.test', 4, { waitMs: 2_000 });
    const { id } = await next();
    main.postMessage({ type: 'resolved', id, ok: false, code: RESOLVER_HELD, message: 'held' });
    await assert.rejects(
      asked,
      (error: Error) => codeOf(error) === RESOLVER_HELD && error.message === 'held',
    );
  });

  it('says a main thread that did not take the lookup is the probe overloaded, not given up', async () => {
    // Nobody reads the main thread's end: a stalled event loop, as far as the worker can tell.
    const { client } = channel();
    const before = nameLookups.stats();
    await assert.rejects(
      checkedTarget({
        host: 'switch.example.test',
        resolve: client.resolve,
        family: 4,
        timeoutMs: 400,
        signal: new AbortController().signal,
        verb: 'query',
        doing: 'querying switch.example.test:161 over SNMP',
      }),
      (error: Error) => {
        assert.equal(
          error.message,
          'the device’s host name could not be resolved, querying switch.example.test:161 over ' +
            'SNMP — the probe’s main thread did not take the lookup within 200 ms (the probe is ' +
            'overloaded)',
        );
        return true;
      },
    );
    assert.deepEqual(nameLookups.stats(), before, 'neither in flight here nor given up');
    assert.equal(client.pending, 0);
  });

  it('waits for the answer once the main thread has taken the lookup', async () => {
    const { client, main, next } = channel({ ackWithinMs: 50 });
    const asked = client.resolve('slow.test', 4, { waitMs: 2_000 });
    const { id } = await next();
    main.postMessage({ type: 'resolve-ack', id });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(client.pending, 1, 'still waiting, past the bound for the ack');
    main.postMessage({ type: 'resolved', id, ok: true, addresses: A });
    assert.deepEqual(await asked, A);
  });

  it('ends its own wait at its bound and a little slack, and drops the late answer by its id', async () => {
    const { client, main, next } = channel({ slackMs: 20 });
    const asked = client.resolve('late.test', 4, { waitMs: 60 });
    const { id } = await next();
    main.postMessage({ type: 'resolve-ack', id });
    await assert.rejects(within(1_000, 'the client to end its own wait', asked), (error: Error) => {
      assert.equal(codeOf(error), RESOLVER_LATE);
      assert.match(error.message, /had not answered late\.test within 60 ms/u);
      return true;
    });
    assert.equal(client.pending, 0, 'nothing left waiting');
    main.postMessage({ type: 'resolved', id, ok: true, addresses: A });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.pending, 0);
  });

  it('asks fresh for “Check now”, and keeps what the resolver said about the answer for the check', async () => {
    const { client, main, next } = channel({ fresh: true });
    const asked = client.resolve('a.test', 4, { waitMs: 2_000 });
    const request = await next();
    assert.equal(request.fresh, true);
    main.postMessage({ type: 'resolved', id: request.id, ok: true, addresses: A, note: 'kept' });
    await asked;
    assert.deepEqual(client.takeNotes(), ['kept']);
    assert.deepEqual(client.takeNotes(), [], 'once');
  });

  it('answers a check whose main thread took longer than a second but answered inside the bound', async () => {
    // `P-426`'s review: an unread request failed at a second, though a main thread stalled for
    // two then answered a warm name at once, inside SNMP's two and a half.
    const { client, main, next } = channel();
    const asked = client.resolve('warm.test', 4, { waitMs: 2_500 });
    const request = await next();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(client.pending, 1, 'still waiting, unacknowledged, past a second');
    main.postMessage({ type: 'resolved', id: request.id, ok: true, addresses: A });
    assert.deepEqual(await within(1_000, 'the answer', asked), A);
  });

  it('gives the main thread the whole bound to take a lookup, ending just before it', () => {
    assert.equal(ackWithinMs(2_500), 2_500 - ACK_LEAD_MS);
    assert.equal(ackWithinMs(1_000), 1_000 - ACK_LEAD_MS);
    assert.equal(ackWithinMs(10), 1, 'never at once');
    assert.equal(ACK_LEAD_MS, 20);
    assert.equal(
      SETTLE_SLACK_MS,
      500,
      'longer than the 250 ms the resolver keeps a waiter past its bound',
    );
    assert.equal(RESOLVER_BUSY, 'ERESOLVERBUSY');
  });
});
