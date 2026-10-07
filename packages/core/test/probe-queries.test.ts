import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { CheckResult, ProbeQuery, SensorAssignment } from '@ms/shared';
import { ProbeQueryService, type ProbeQuerySender } from '../src/probes/queries.js';
import { ProbeRefusals } from '../src/probes/refusals.js';
import { silent } from './support/tree.js';

/**
 * On-demand queries, with no socket and no clock (`R-09`).
 *
 * **Every test here is about a promise settling.** The mechanism's whole job is that an API call
 * waiting on a probe always gets an answer — one that arrives, one that times out, one that says
 * the probe has gone — because the alternative is not a slow request but a request that never
 * finishes, and enough of those is the API going quiet with nothing in the log to explain it.
 *
 * The timer is injected rather than waited on, so a deadline is a function call. A test that
 * genuinely slept for its timeout would be the exact shape `P-21` had to take out of the suite.
 */

const ASSIGNMENT: SensorAssignment = {
  sensorId: 42,
  sensorType: 'icmp.ping',
  params: { count: 4 },
  target: { host: '192.0.2.10', ipVersion: 'v4' },
  intervalSeconds: 60,
  timeoutMs: 5_000,
};

const QUERY: ProbeQuery = { kind: 'check', assignment: ASSIGNMENT };

const RESULT: CheckResult = {
  sensorId: 42,
  at: '2026-08-29T10:00:00.000Z',
  outcome: 'ok',
  message: '4/4 replies',
  durationMs: 612,
  channels: [{ key: 'rtt', value: 1.2, name: 'Response time', unit: 'ms' }],
};

/** A sender that records what it was asked to send and answers what a test tells it to. */
class StubSender implements ProbeQuerySender {
  readonly sent: {
    probeObjectId: number;
    message:
      | { kind: 'ask'; queryId: string; query: ProbeQuery; timeoutMs: number; peerVersion?: number }
      | { kind: 'cancel'; queryId: string };
  }[] = [];
  delivery: ReturnType<ProbeQuerySender['sendQuery']> = { kind: 'sent' };
  /** What the probe on the line speaks, by probe object; a probe absent here is not connected. */
  readonly speaks = new Map<number, number>();

  protocolVersionOf(probeObjectId: number): number {
    return this.speaks.get(probeObjectId) ?? 0;
  }

  sendQuery(
    probeObjectId: number,
    message:
      | { kind: 'ask'; queryId: string; query: ProbeQuery; timeoutMs: number; peerVersion?: number }
      | { kind: 'cancel'; queryId: string },
  ): ReturnType<ProbeQuerySender['sendQuery']> {
    this.sent.push({ probeObjectId, message });
    return this.delivery;
  }

  /** The ids of the queries that actually went out, in order. */
  get asked(): string[] {
    return this.sent.filter((s) => s.message.kind === 'ask').map((s) => s.message.queryId);
  }

  get cancelled(): string[] {
    return this.sent.filter((s) => s.message.kind === 'cancel').map((s) => s.message.queryId);
  }
}

/** Timers a test fires by hand, so a deadline costs nothing and happens exactly when asked. */
function fakeTimer(): {
  timer: {
    set: (fn: () => void, ms: number) => NodeJS.Timeout;
    clear: (h: NodeJS.Timeout) => void;
  };
  fire: () => void;
  pending: () => number;
} {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    timer: {
      set: (fn) => {
        const id = next;
        next += 1;
        fns.set(id, fn);
        return id as unknown as NodeJS.Timeout;
      },
      clear: (handle) => {
        fns.delete(handle as unknown as number);
      },
    },
    fire: () => {
      for (const [id, fn] of [...fns]) {
        fns.delete(id);
        fn();
      }
    },
    pending: () => fns.size,
  };
}

function build(
  overrides: { maxInFlight?: number; maxInFlightPerProbe?: number; refusals?: ProbeRefusals } = {},
): {
  service: ProbeQueryService;
  sender: StubSender;
  clock: ReturnType<typeof fakeTimer>;
} {
  const sender = new StubSender();
  const clock = fakeTimer();
  const service = new ProbeQueryService({
    logger: silent,
    sender,
    timer: clock.timer,
    ...overrides,
  });
  return { service, sender, clock };
}

/**
 * A bounded suite, and the bound is load-bearing.
 *
 * Every failure mode here is "a promise that never settles", so the natural way for one of these
 * tests to fail is to *hang* rather than to assert — which hangs the whole runner, exactly as
 * `P-06` found. The assertions below are ordered so a regression trips one before anything is
 * awaited; this is the backstop for the ones that are not.
 */
describe('on-demand probe queries', { timeout: 20_000 }, () => {
  it('hands a probe’s answer to the caller that asked for it', async () => {
    const { service, sender } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();

    const queryId = sender.asked[0];
    assert.ok(queryId !== undefined, 'nothing was sent');
    service.deliver({ queryId, result: RESULT }, 1);

    const outcome = await waiting;
    assert.equal(outcome.kind, 'ok');
    assert.equal(outcome.result.message, '4/4 replies');
    assert.equal(service.stats().answered, 1);
    assert.equal(service.stats().inFlight, 0);
  });

  it('gives two callers their own answers, whichever order they arrive in', async () => {
    // The defect this catches is the one a correlation id exists for: two operators pressing
    // "check now" on different sensors and each being shown the other's device.
    const { service, sender } = build();
    const first = service.ask(1, QUERY);
    const second = service.ask(2, QUERY);
    await Promise.resolve();

    const [a, b] = sender.asked;
    assert.ok(a !== undefined && b !== undefined);
    assert.notEqual(a, b, 'two queries must not share an id');

    // Answered out of order on purpose.
    service.deliver({ queryId: b, result: { ...RESULT, message: 'second' } }, 2);
    service.deliver({ queryId: a, result: { ...RESULT, message: 'first' } }, 1);

    const [one, two] = await Promise.all([first, second]);
    assert.ok(one.kind === 'ok' && two.kind === 'ok');
    assert.equal(one.result.message, 'first');
    assert.equal(two.result.message, 'second');
  });

  it('refuses an answer from any probe but the one asked, and waits for the real one', async () => {
    // `P-228`. The probe a query was put to was recorded and never compared, so any connected
    // probe holding the id could settle it with a reading of its choosing — the answer an
    // operator was waiting on. A GID with no probe object behind it was asked nothing either.
    const refusals = new ProbeRefusals();
    const { service, sender } = build({ refusals });
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';

    service.deliver({ queryId, result: { ...RESULT, message: 'forged' } }, 2);
    service.deliver({ queryId, result: { ...RESULT, message: 'forged' } }, null);
    assert.equal(service.stats().answered, 0, 'neither settled it');
    assert.equal(service.stats().foreign, 2);
    assert.equal(service.stats().inFlight, 1, 'the caller is still waiting');
    assert.deepEqual(refusals.countsFor(2), { refused: 1, foreignRecently: 1 });

    service.deliver({ queryId, result: RESULT }, 1);
    const outcome = await waiting;
    assert.ok(outcome.kind === 'ok');
    assert.equal(outcome.result.message, '4/4 replies', 'and got the answer from the probe asked');
  });

  it('passes a probe’s own refusal through rather than calling it a success', async () => {
    const { service, sender } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';
    service.deliver({ queryId, failure: 'busy', message: 'the probe is already running one' }, 1);

    const outcome = await waiting;
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.failure, 'busy');
    assert.match(outcome.message, /already running/);
  });

  // `P-289`: a result the core could not make fit used to close the link, and the caller was
  // told the probe had gone. The parser now takes it out of the answer and says so.
  it('answers too-old for a result that cannot be made to fit, and counts it on the probe', async () => {
    const refusals = new ProbeRefusals();
    const { service, sender } = build({ refusals });
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';
    service.deliver({ queryId, message: 'from the probe' }, 1, {
      refused: [{ sensorId: 42, at: RESULT.at, reason: '/outcome: must be equal to one of' }],
      fitted: [],
    });

    const outcome = await waiting;
    assert.ok(outcome.kind === 'failed', JSON.stringify(outcome));
    assert.equal(outcome.failure, 'too-old', 'an upgrade mends it, and a retry does not');
    assert.match(outcome.message, /does not fit the protocol \(\/outcome: must be equal/);
    assert.match(outcome.message, /upgrade the probe$/);
    assert.equal(service.stats().unfit, 1);
    assert.equal(service.stats().answered, 1);
    assert.deepEqual(refusals.countsFor(1), { refused: 1, foreignRecently: 0 });
  });

  it('hands over a result the parser fitted, and counts nothing', async () => {
    const refusals = new ProbeRefusals();
    const { service, sender } = build({ refusals });
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';
    service.deliver({ queryId, result: RESULT }, 1, {
      refused: [],
      fitted: [
        { sensorId: 42, at: RESULT.at, reason: '', problems: ['dropped'], droppedChannels: 1 },
      ],
    });

    const outcome = await waiting;
    assert.ok(outcome.kind === 'ok');
    assert.deepEqual(outcome.result, RESULT);
    assert.equal(service.stats().unfit, 0);
    assert.deepEqual(refusals.countsFor(1), { refused: 0, foreignRecently: 0 });
  });

  it('refuses an unfit answer from another probe as foreign, not as unfit', async () => {
    const refusals = new ProbeRefusals();
    const { service, sender } = build({ refusals });
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';
    service.deliver({ queryId }, 2, {
      refused: [{ sensorId: 42, at: RESULT.at, reason: '/outcome: invalid' }],
      fitted: [],
    });
    assert.equal(service.stats().foreign, 1);
    assert.equal(service.stats().unfit, 0);
    assert.equal(service.stats().inFlight, 1, 'the caller is still waiting');
    service.deliver({ queryId, result: RESULT }, 1);
    assert.equal((await waiting).kind, 'ok');
  });

  it('names a probe that answered with nothing at all', async () => {
    // A peer that sends neither a result nor a reason has still answered, so the caller must be
    // settled — the alternative is spending the whole deadline on a message already received.
    const { service, sender } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    service.deliver({ queryId: sender.asked[0] ?? '' }, 1);

    const outcome = await waiting;
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.failure, 'unsupported');
  });

  it('answers offline without sending anything, rather than waiting out a deadline', async () => {
    const { service, sender } = build();
    sender.delivery = { kind: 'offline' };

    const outcome = await service.ask(1, QUERY);
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.failure, 'offline');
    assert.equal(service.stats().inFlight, 0, 'nothing should be left waiting');
  });

  it('separates a probe that is too old from one that is merely absent', async () => {
    // `R-06`'s distinction, and it matters more here than anywhere: offline is a retry and
    // too-old is an upgrade, and a UI that cannot tell them apart shows the wrong button.
    const { service, sender } = build();
    sender.delivery = { kind: 'too-old', protocolVersion: 5 };

    const outcome = await service.ask(1, QUERY);
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.failure, 'too-old');
    assert.match(outcome.message, /protocol 5/);
    assert.match(outcome.message, /8/, 'and what it would need');
  });

  it('gives up on its own deadline, and tells the probe to stop', async () => {
    const { service, sender, clock } = build();
    const waiting = service.ask(1, QUERY, { timeoutMs: 2_000 });
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';

    clock.fire();
    const outcome = await waiting;
    assert.ok(outcome.kind === 'failed');
    assert.equal(outcome.failure, 'timeout');
    assert.match(outcome.message, /2000 ms/);
    // Cancelled rather than left running: the probe is holding a worker for an answer nobody
    // can receive any more.
    assert.deepEqual(sender.cancelled, [queryId]);
    assert.equal(service.stats().timedOut, 1);
    assert.equal(service.stats().inFlight, 0);
  });

  it('cancels its deadline once answered, rather than leaking a timer per query', async () => {
    // Not cosmetic. A timer left armed fires later against an id nobody holds, which counts a
    // timeout that never happened and sends the probe a `query-cancel` for work it finished
    // minutes ago — and one of those accumulates for every check anybody ever runs.
    const { service, sender, clock } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    service.deliver({ queryId: sender.asked[0] ?? '', result: RESULT }, 1);
    assert.ok((await waiting).kind === 'ok');

    assert.equal(clock.pending(), 0, 'the deadline should have been cleared');
    clock.fire();
    assert.equal(service.stats().timedOut, 0);
    assert.deepEqual(sender.cancelled, [], 'and nothing should be cancelled after an answer');
  });

  it('ignores an answer that lost the race with its own deadline', async () => {
    // Ordinary rather than exceptional — the probe replied a moment late — and settling a
    // promise twice is the bug this avoids.
    const { service, sender, clock } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();
    const queryId = sender.asked[0] ?? '';

    clock.fire();
    assert.ok((await waiting).kind === 'failed');
    service.deliver({ queryId, result: RESULT }, 1);
    assert.equal(service.stats().answered, 0, 'a late answer settles nobody');
  });

  it('settles everyone waiting on a probe whose link has gone', async () => {
    // Without this the caller waits out its full deadline for an answer that provably cannot
    // arrive: the socket that would have carried it no longer exists.
    const { service } = build();
    const first = service.ask(1, QUERY);
    const second = service.ask(1, QUERY);
    const other = service.ask(2, QUERY);
    await Promise.resolve();

    service.probeDisconnected(1);
    for (const outcome of await Promise.all([first, second])) {
      assert.ok(outcome.kind === 'failed');
      assert.equal(outcome.failure, 'offline');
      assert.match(outcome.message, /disconnected/);
    }
    assert.equal(service.stats().abandoned, 2);
    assert.equal(service.stats().inFlight, 1, 'the other probe’s query is untouched');

    service.stop();
    assert.ok((await other).kind === 'failed');
  });

  it('leaves nothing hanging when the core shuts down', async () => {
    const { service } = build();
    const waiting = service.ask(1, QUERY);
    await Promise.resolve();

    service.stop();
    const outcome = await waiting;
    assert.ok(outcome.kind === 'failed');
    assert.match(outcome.message, /shutting down/);
    assert.equal(service.stats().inFlight, 0);
  });

  it('refuses past the bound, immediately and counted', async () => {
    // `CLAUDE.md`: backpressure is visible, never silent. A refusal an operator can retry beats
    // a spinner queued behind other people's deadlines — and the count is what puts it on a
    // dashboard rather than in somebody's memory.
    const { service, sender, clock } = build({ maxInFlight: 2 });
    const held = [service.ask(1, QUERY), service.ask(2, QUERY)];
    await Promise.resolve();

    const refusal = service.ask(3, QUERY);
    // **Checked before the await, on purpose.** A bound that fails open does not make this
    // assertion fail — it makes the query be *sent*, and then awaiting an answer nobody will
    // give hangs the test and the runner with it. The observable difference is here.
    await Promise.resolve();
    assert.equal(sender.asked.length, 2, 'the refused query never reached a probe');

    const refused = await refusal;
    assert.ok(refused.kind === 'failed');
    assert.equal(refused.failure, 'busy');
    assert.match(refused.message, /2 on-demand queries/);
    assert.equal(service.stats().refused, 1);

    clock.fire();
    await Promise.all(held);
  });

  it('bounds one probe separately, so a dead device cannot spend the whole allowance', async () => {
    const { service, sender, clock } = build({ maxInFlight: 10, maxInFlightPerProbe: 2 });
    const held = [service.ask(1, QUERY), service.ask(1, QUERY)];
    await Promise.resolve();

    const refusal = service.ask(1, QUERY);
    await Promise.resolve();
    assert.equal(sender.asked.length, 2, 'the refused query never reached a probe');

    const refused = await refusal;
    assert.ok(refused.kind === 'failed');
    assert.match(refused.message, /for this probe/);

    // A different probe is unaffected, which is the whole point of the second bound.
    const elsewhere = service.ask(2, QUERY);
    await Promise.resolve();
    assert.equal(service.stats().inFlight, 3);

    clock.fire();
    await Promise.all([...held, elsewhere]);
  });

  it('lets the allowance back once a query finishes', async () => {
    const { service, sender } = build({ maxInFlight: 1 });
    const first = service.ask(1, QUERY);
    await Promise.resolve();
    const refusal = service.ask(1, QUERY);
    await Promise.resolve();
    assert.equal(sender.asked.length, 1, 'the refused query never reached a probe');
    assert.ok((await refusal).kind === 'failed');

    service.deliver({ queryId: sender.asked[0] ?? '', result: RESULT }, 1);
    assert.ok((await first).kind === 'ok');

    const second = service.ask(1, QUERY);
    await Promise.resolve();
    service.deliver({ queryId: sender.asked[1] ?? '', result: RESULT }, 1);
    assert.ok((await second).kind === 'ok');
  });

  it('sends the whole assignment, so the check is the one the schedule would run', async () => {
    const { service, sender, clock } = build();
    const waiting = service.ask(1, QUERY, { timeoutMs: 9_000 });
    await Promise.resolve();

    const sent = sender.sent[0];
    assert.ok(sent?.message.kind === 'ask');
    assert.equal(sent.probeObjectId, 1);
    assert.equal(sent.message.timeoutMs, 9_000);
    assert.deepEqual(sent.message.query, QUERY);
    assert.equal('peerVersion' in sent.message, false, 'and no version nobody decided against');

    clock.fire();
    await waiting;
  });

  it('says what the probe on the line speaks, and 0 with nobody on it (A-41c)', () => {
    const { service, sender } = build();
    sender.speaks.set(1, 23);
    assert.equal(service.peerVersion(1), 23);
    assert.equal(service.peerVersion(2), 0);
    // A sender with no sessions to ask is nobody on the line either.
    const bare = new ProbeQueryService({
      logger: silent,
      sender: { sendQuery: () => ({ kind: 'offline' }) },
    });
    assert.equal(bare.peerVersion(1), 0);
  });

  it('sends a query with the version it was decided against (A-41c)', async () => {
    const { service, sender, clock } = build();
    const waiting = service.ask(1, QUERY, { timeoutMs: 9_000, peerVersion: 24 });
    await Promise.resolve();
    const sent = sender.sent[0];
    assert.ok(sent?.message.kind === 'ask');
    assert.equal(sent.message.peerVersion, 24);
    clock.fire();
    await waiting;
  });
});
