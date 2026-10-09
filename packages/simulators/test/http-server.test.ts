import { strict as assert } from 'node:assert';
import { Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { HttpSimulator } from '../src/http-server.js';
import { within } from './support/within.js';

/**
 * The harness's own tests (`P-06`).
 *
 * **A simulator nobody tests is a false-green machine.** Every assertion in every sensor test
 * rests on this answering the way it says it does; a `delayMs` that did not delay would turn a
 * timeout test into a test that passes for the wrong reason, and nothing downstream would notice
 * — the sensor test would still be green, which is exactly the failure mode that makes an
 * untested harness worse than no harness.
 */

describe('the HTTP simulator', () => {
  let http: HttpSimulator;

  before(async () => {
    http = new HttpSimulator({
      routes: {
        '/': { body: 'hello' },
        '/json': { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
        '/slow': { delayMs: 120, body: 'eventually' },
        '/drip': { dripMs: 30, dripChunks: 4, body: 'abcdefgh' },
        '/late-body': { bodyDelayMs: 150, body: 'thought about it' },
        '/hang': { hang: true },
        '/reset': { reset: true },
        '/moved': { redirectTo: '/' },
        '/flaky': [{ status: 500, body: 'no' }, { status: 500, body: 'no' }, { body: 'yes' }],
      },
    });
    await http.start();
  });

  after(async () => {
    await http.stop();
  });

  const get = async (path: string): Promise<{ status: number; body: string }> => {
    const response = await fetch(http.url(path), { redirect: 'manual' });
    return { status: response.status, body: await response.text() };
  };

  it('answers a scripted route', async () => {
    assert.deepEqual(await get('/'), { status: 200, body: 'hello' });
  });

  it('404s a path with no route, rather than hanging or crashing', async () => {
    // The default matters: a test that mistypes a path should see a 404 it can read, not a
    // timeout it has to bisect.
    assert.equal((await get('/nope')).status, 404);
  });

  it('sends the headers it was given', async () => {
    const response = await fetch(http.url('/json'));
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });

  it('actually delays, which is the whole point of scripting latency', async () => {
    const started = Date.now();
    await get('/slow');
    assert.ok(Date.now() - started >= 100, 'a delay that does not delay is a silent false pass');
  });

  it('drips a body slowly while answering immediately', async () => {
    // The difference `dripMs` exists for: time-to-first-byte is fast and time-to-last-byte is
    // slow, which is what separates a connect timeout from a read timeout and what a body-size
    // bound is tested against.
    const started = Date.now();
    const response = await fetch(http.url('/drip'));
    const headersAt = Date.now() - started;
    const body = await response.text();
    const bodyAt = Date.now() - started;

    assert.equal(body, 'abcdefgh');
    assert.ok(bodyAt >= 80, `the body should trickle, took ${String(bodyAt)} ms`);
    assert.ok(headersAt < bodyAt, 'the head should arrive before the body has finished');
  });

  it('answers the head at once and the body later, which is a different fault', async () => {
    // A server that accepted and answered promptly and then thought about the body, against one
    // that had not answered at all. An operator debugging a slow check needs to know which, and
    // `flushHeaders` is what makes the distinction real rather than staged.
    const started = Date.now();
    const response = await fetch(http.url('/late-body'));
    const headersAt = Date.now() - started;
    assert.equal(await response.text(), 'thought about it');
    const bodyAt = Date.now() - started;

    assert.ok(headersAt < 100, `the head should not wait, took ${String(headersAt)} ms`);
    assert.ok(bodyAt >= 140, `the body should, took ${String(bodyAt)} ms`);
  });

  it('hangs when told to, and the client is the one left waiting', async () => {
    const controller = new AbortController();
    const pending = fetch(http.url('/hang'), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await assert.rejects(() => pending);
  });

  // **A hang is an open connection, and `close()` waits for open connections** — so a simulator
  // that did not destroy them would hang its own teardown. That failure is worse than it looks:
  // it does not fail, it *stops*, and what a developer sees is a test run that never finishes
  // with no indication of which fixture is holding it. The client is deliberately never aborted,
  // because an aborted client tidies the socket up and hides the bug.
  //
  // The wait before `stop()` is what the table varies (`P-63`). At 50 ms the request has reached
  // the hang route and the socket is parked there — which the old tracking handled, so that row
  // passes either way and is a regression guard for nothing. At 0 ms the connection may or may
  // not have been dispatched yet, and only the "not yet" case exercises the defect: a measured
  // 17 runs in 100 idle, 27 in 100 loaded. Both rows are kept because they are cheap and they
  // document the two states, but **neither is the guard** — the deterministic case below is.
  for (const waitMs of [0, 50]) {
    it(`shuts down ${String(waitMs)} ms into a request that is still hanging`, async () => {
      const hanging = new HttpSimulator({ routes: { '/hang': { hang: true } } });
      await hanging.start();
      // Abortable, but not aborted until the race is over: aborting first tidies the socket up
      // and hides the defect, while never aborting at all means a simulator that *does* hang
      // takes the whole test process down with it — no failure, just a run that stops. The
      // ordering keeps both properties.
      const controller = new AbortController();
      const pending = fetch(hanging.url('/hang'), { signal: controller.signal }).catch(
        () => undefined,
      );
      // Always a real turn of the event loop, even at 0: the connection has to be *established*
      // for this to test anything, and calling `stop()` in the same microtask as `fetch()` just
      // finds a server with nothing attached to it.
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      try {
        // Generous on purpose: the claim is that it does not hang, and a hang is unbounded, so a
        // bigger number catches the defect just as surely and never fires on a busy machine.
        await within(5_000, 'the simulator to stop with a request hanging', hanging.stop());
      } finally {
        controller.abort();
        await pending;
      }
    });
  }

  it('shuts down with a connection that never sent a request at all', async () => {
    // **The deterministic form of the row above.** A socket that is accepted and never speaks is
    // permanently in the state the timed rows can only catch by luck: open, so `close()` waits
    // for it, and known to nothing that tracked only the hang route's sockets. No sleep, no race
    // — it fails every time against the old tracking, which is what a regression guard has to do.
    const hanging = new HttpSimulator({ routes: { '/hang': { hang: true } } });
    const port = await hanging.start();
    const idle = new Socket();
    try {
      await within(
        5_000,
        'the silent connection to connect',
        new Promise<void>((resolve, reject) => {
          idle.once('connect', resolve);
          idle.once('error', reject);
          idle.connect(port, '127.0.0.1');
        }),
      );
      await within(5_000, 'the simulator to stop with a silent connection open', hanging.stop());
    } finally {
      idle.destroy();
      // A no-op once it has stopped; what stops it when the connection never came up.
      await within(5_000, 'the simulator to stop', hanging.stop());
    }
  });

  it('resets the connection when told to, which is not a status code', async () => {
    await assert.rejects(() => get('/reset'));
  });

  it('redirects with a Location', async () => {
    const response = await fetch(http.url('/moved'), { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
  });

  it('walks a sequence and then repeats its last entry', async () => {
    // "Fails twice then succeeds" is the shape every retry and backoff test needs, and the last
    // entry repeats rather than running out — running out would answer 404 on the fourth call
    // for a reason that has nothing to do with what was being tested.
    assert.equal((await get('/flaky')).status, 500);
    assert.equal((await get('/flaky')).status, 500);
    assert.equal((await get('/flaky')).status, 200);
    assert.equal((await get('/flaky')).status, 200);
  });

  it('records what arrived, method, headers and body', async () => {
    const fresh = new HttpSimulator({ routes: { '/post': { body: 'ok' } } });
    await fresh.start();
    // **`finally`, not a trailing `stop()`.** A simulator stopped after the assertions is a
    // simulator that leaks its server whenever one of them fails — and a leaked server holds the
    // event loop open, so `node --test` never exits. A failing test that hangs the run instead of
    // reporting is how three hours go missing; this file learned that the expensive way.
    try {
      await fetch(fresh.url('/post'), {
        method: 'POST',
        headers: { 'x-marker': 'seen' },
        body: 'the body',
      });

      assert.equal(fresh.requests.length, 1);
      const recorded = fresh.requests[0];
      assert.ok(recorded !== undefined);
      assert.equal(recorded.method, 'POST');
      assert.equal(recorded.url, '/post');
      assert.equal(recorded.body, 'the body');
      assert.equal(recorded.headers['x-marker'], 'seen');
    } finally {
      await fresh.stop();
    }
  });

  it('matches a route by path, ignoring the query string', async () => {
    // Otherwise every test with a query parameter has to spell the whole URL as a route key,
    // which is a fixture that breaks when the code under test adds a cache-buster.
    assert.equal((await get('/?a=1')).body, 'hello');
  });

  it('binds a port the kernel chose, so two of them can run at once', async () => {
    const other = new HttpSimulator();
    await other.start();
    try {
      assert.notEqual(other.port, http.port);
      assert.ok(other.port > 0);
    } finally {
      await other.stop();
    }
  });
});
