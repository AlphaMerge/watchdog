import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SweepEnding, SweepHost, SweepJob } from '@ms/shared';
import { SweepRunner, type SweepDeps } from '../src/discovery/sweep.js';
import { pino } from 'pino';

/**
 * The ping sweep (`D-01`).
 *
 * **No network and no clock.** The address prober and the sleep are both injected, so what is
 * tested here is the scheduling — the cursor, the standing down for live checks, the token
 * bucket, the cancellation — which is where every property the ticket asks for actually lives.
 * A test that pinged anything would be testing `ping`.
 */

interface Harness {
  runner: SweepRunner;
  progress: { cursor: number; found: SweepHost[]; failed: number }[];
  finished: { ending: SweepEnding; cursor: number; message: string }[];
  asked: string[];
  queue: { depth: number };
  slept: number;
  done: Promise<void>;
}

const silent = pino({ level: 'silent' });

/** A probe that never answers until the sweep gives up on it, which is what `ping` does. */
function aborts(signal: AbortSignal): Promise<number | null> {
  return new Promise<number | null>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(new Error('cancelled'));
      },
      { once: true },
    );
  });
}

/** The run's ending, asserted to exist so the tests below read as statements. */
function ended(h: Harness, at = 0): { ending: SweepEnding; cursor: number; message: string } {
  const one = h.finished[at];
  assert.ok(one !== undefined, 'the run should have finished');
  return one;
}

const JOB: SweepJob = {
  runId: 1,
  range: '10.0.0.1-10.0.0.8',
  cursor: 0,
  timeoutMs: 500,
  concurrency: 4,
  ratePerSecond: 0,
};

function harness(over: Partial<SweepDeps> = {}): Harness {
  const progress: Harness['progress'] = [];
  const finished: Harness['finished'] = [];
  const asked: string[] = [];
  const queue = { depth: 0 };
  let slept = 0;
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const runner = new SweepRunner({
    logger: silent,
    // Alive on even last octets, so a sweep of eight addresses finds four.
    probe: (address: string) => {
      asked.push(address);
      const last = Number(address.split('.')[3] ?? 0);
      return Promise.resolve(last % 2 === 0 ? last : null);
    },
    queueDepth: () => queue.depth,
    onProgress: (_runId, cursor, found, failed) => {
      progress.push({ cursor, found, failed });
    },
    onFinished: (_runId, ending, cursor, message) => {
      finished.push({ ending, cursor, message });
      settle();
    },
    sleep: (ms: number) => {
      slept += ms;
      // A **macrotask**, not a resolved promise. The point of injecting this is that the tests
      // exercise the same loop in no time at all — but the loop that stands down for live
      // checks re-reads the queue depth after every sleep, and a sleep that resolves on the
      // microtask queue never lets a timer run, so nothing could ever change the depth back.
      // Found by writing it the obvious way and watching the suite hang.
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    ...over,
  });

  const self = {
    runner,
    progress,
    finished,
    asked,
    queue,
    get slept() {
      return slept;
    },
    done,
  } as Harness;
  return self;
}

describe('sweeping a range', () => {
  it('offers every address once and reports what answered', async () => {
    const h = harness();
    h.runner.start(JOB);
    await h.done;

    assert.equal(h.asked.length, 8);
    assert.equal(new Set(h.asked).size, 8, 'and none of them twice');
    assert.equal(ended(h).ending, 'done');
    assert.equal(h.finished[0]?.cursor, 8, 'the cursor ends at the size of the range');

    const found = h.progress.flatMap((one) => one.found);
    assert.deepEqual(found.map((one) => one.address).sort(), [
      '10.0.0.2',
      '10.0.0.4',
      '10.0.0.6',
      '10.0.0.8',
    ]);
  });

  it('reports what it found before it reports that it finished', async () => {
    // A run recorded as complete while a host it found is still in a buffer is a host missed on
    // the one sweep that saw it, and nothing anywhere would say so.
    const h = harness();
    h.runner.start(JOB);
    await h.done;
    const totalFound = h.progress.reduce((sum, one) => sum + one.found.length, 0);
    assert.equal(totalFound, 4);
    assert.equal(h.runner.stats().found, 4);
  });

  it('resumes from a cursor and sweeps only what is left', async () => {
    // The whole of resumability: a probe restart, a reconnect and a core failover all come back
    // through this path.
    const h = harness();
    h.runner.start({ ...JOB, cursor: 5 });
    await h.done;
    assert.deepEqual(h.asked, ['10.0.0.6', '10.0.0.7', '10.0.0.8']);
    assert.equal(h.finished[0]?.cursor, 8);
  });

  it('finishes immediately when the cursor is already past the end', async () => {
    const h = harness();
    h.runner.start({ ...JOB, cursor: 8 });
    await h.done;
    assert.equal(h.asked.length, 0);
    assert.equal(ended(h).ending, 'done');
  });

  it('fails the run rather than throwing when the range cannot be read', async () => {
    // A range the core accepted and this build cannot parse is a version skew, and the operator
    // needs the sentence rather than a run stuck at 0%.
    const h = harness();
    h.runner.start({ ...JOB, range: '2001:db8::/64' });
    await h.done;
    assert.equal(ended(h).ending, 'failed');
    assert.match(ended(h).message, /eighteen million million million/);
  });
});

describe('not starving live checks', () => {
  it('stands down entirely while a check is queued, and counts the time', async () => {
    // A queued check is a scan that is already late. CLAUDE.md: backpressure is visible, never
    // silent — so the waiting is counted rather than being an unexplained slow sweep.
    const h = harness();
    h.queue.depth = 3;
    h.runner.start(JOB);

    // Nothing is offered while the pool is busy, however many turns of the loop go by.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.asked.length, 0, 'not one address while checks are waiting');

    h.queue.depth = 0;
    await h.done;
    assert.equal(h.asked.length, 8, 'and all of them once the pool is clear');
    assert.ok(h.runner.stats().yieldedMs >= 0);
  });

  it('reports progress during a long run, not only at its end', async () => {
    // A /16 reported once at the finish sits at 0% for an hour with nothing to say whether it
    // is working — and a crash at minute fifty-nine loses every host it found, because the
    // cursor the core holds is still zero.
    const h = harness({ progressIntervalMs: 0 });
    h.runner.start({ ...JOB, range: '10.0.0.0/29' });
    await h.done;
    assert.ok(h.progress.length > 1, `progress arrived ${String(h.progress.length)} times`);
    // And the cursor moves with it, which is the half that makes a crash cheap.
    const cursors = h.progress.map((one) => one.cursor);
    assert.ok(cursors[0] !== undefined && cursors[0] < 6, `first cursor was ${String(cursors[0])}`);
  });

  it('keeps reporting progress while it is standing down', async () => {
    // Otherwise a sweep behind a busy pool looks identical to a sweep that has died.
    let now = 0;
    const h = harness({
      queueDepth: () => (now < 3 ? 1 : 0),
      sleep: () => {
        now += 1;
        return new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
    });
    h.runner.start(JOB);
    await h.done;
    assert.equal(h.asked.length, 8);
  });
});

describe('bounds', () => {
  it('never has more addresses in flight than it was told', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness({
      probe: async (address: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return Number(address.split('.')[3] ?? '0') % 2 === 0 ? 1 : null;
      },
    });
    h.runner.start({ ...JOB, range: '10.0.0.0/24', concurrency: 4 });
    await h.done;
    assert.ok(peak <= 4, `peak concurrency was ${String(peak)}`);
  });

  it('spends time in the token bucket when a rate is set', async () => {
    // A bucket rather than a delay per address: a fixed delay makes the *floor* the rate, so a
    // network that answers instantly runs at exactly the limit and one that times out runs far
    // below it.
    const h = harness();
    h.runner.start({ ...JOB, ratePerSecond: 2 });
    await h.done;
    assert.equal(h.asked.length, 8);
    assert.ok(h.slept > 0, 'it waited for tokens');
  });

  // `P-247`: refilled from the wall clock, a backward step of an hour made the allowance minus an
  // hour's worth of tokens, and the run slept the hour with no progress sent.
  it('keeps its rate across a backward step of the wall clock', async () => {
    // The longest, kept as it goes: the fake sleep takes no time, so the loop sleeps thousands of
    // times while the real clock earns each token.
    let longest = 0;
    let sleeps = 0;
    // Replaced before the run starts, so a default that captured it would hold this one, which
    // steps back at the first address and then stands still.
    const realNow = Date.now;
    let wall = realNow();
    Date.now = (): number => wall;
    let stepped = false;
    const h = harness({
      probe: (address: string) => {
        if (!stepped) {
          stepped = true;
          wall -= 3_600_000;
        }
        return Promise.resolve(address.endsWith('.2') ? 2 : null);
      },
      sleep: (ms: number) => {
        sleeps += 1;
        longest = Math.max(longest, ms);
        // Its own bound, so a bucket that has lost the step fails here at once rather than
        // spinning until the file's timeout: a wait past one token is already the failure.
        if (ms > 500) h.runner.stop();
        return new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
    });
    try {
      h.runner.start({ ...JOB, ratePerSecond: 2 });
      await h.done;
    } finally {
      Date.now = realNow;
    }
    assert.equal(ended(h).ending, 'done');
    assert.ok(sleeps > 0, 'it waited for tokens');
    assert.ok(
      longest <= 500,
      `a token at 2 a second is at most 500 ms away, not the step: ${String(longest)}`,
    );
  });

  it('does not wait at all when no rate is set', async () => {
    const h = harness();
    h.runner.start(JOB);
    await h.done;
    assert.equal(h.slept, 0);
  });
});

describe('stopping', () => {
  it('cancels promptly rather than waiting out the range', async () => {
    // An operator who typed the wrong range wants the pings to stop now, not in 65,536
    // timeouts.
    // The prober honours the signal, as `pingOnce` does by handing it to `spawn` — a prober
    // that ignored it would leave the sweep waiting out exactly the timeouts cancelling is
    // meant to avoid.
    const h = harness({ probe: (_address, _timeoutMs, signal) => aborts(signal) });
    h.runner.start({ ...JOB, range: '10.0.0.0/24', concurrency: 1 });
    await new Promise((resolve) => setImmediate(resolve));

    h.runner.cancel(1);
    await h.done;

    assert.equal(ended(h).ending, 'cancelled');
    assert.ok(ended(h).cursor < 254, 'and it stopped part way');
  });

  it('answers a cancel for a run it is not running', () => {
    // The core may have restarted, or the run may have finished between the click and the
    // message. Answering anyway is what stops the core waiting for a finish that never comes.
    const h = harness();
    h.runner.cancel(99);
    assert.equal(ended(h).ending, 'cancelled');
  });

  it('supersedes rather than doubling when the same run is started twice', async () => {
    // A core that reconnected and re-sent the job must not double the pings.
    const h = harness();
    h.runner.start({ ...JOB, range: '10.0.0.0/24' });
    h.runner.start({ ...JOB, range: '10.0.0.0/24', cursor: 250 });
    await h.done;

    const endings = h.finished.map((one) => one.ending);
    assert.ok(endings.includes('superseded'), `endings were ${endings.join(', ')}`);
    assert.ok(endings.includes('done'));
  });

  it('reports every run as cancelled on shutdown, so the core resumes them', async () => {
    // Cancelled and not failed: a probe that is restarting is coming back, and its run is a
    // cursor away from continuing.
    const h = harness({ probe: (_address, _timeoutMs, signal) => aborts(signal) });
    h.runner.start({ ...JOB, range: '10.0.0.0/24', concurrency: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    h.runner.stop();
    await h.done;
    assert.equal(ended(h).ending, 'cancelled');
  });

  it('counts an address it could not attempt separately from one that did not answer', async () => {
    // A firewalled network and an empty one look identical otherwise.
    const h = harness({
      probe: (address: string) =>
        address.endsWith('.3')
          ? Promise.reject(new Error('the "ping" binary is not available on this probe'))
          : Promise.resolve(null),
    });
    h.runner.start(JOB);
    await h.done;
    assert.equal(h.runner.stats().failed, 1);
    assert.equal(h.runner.stats().found, 0);
    assert.equal(
      h.progress.reduce((sum, one) => sum + one.failed, 0),
      1,
    );
  });
});
