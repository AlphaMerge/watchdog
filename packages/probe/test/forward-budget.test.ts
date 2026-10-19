import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  FORWARD_HOLD_MS,
  ForwardBudget,
  GAI_TOKENS,
  questionsOf,
  type GaiToken,
} from '../src/resolver/forward-budget.js';

/**
 * The question budget's tokens (`P-432` §1.6, S3): what a helper `getaddrinfo` holds, what a loss
 * leaves behind, U, and the peak of the questions open at the forwarder. The walk's ledger is
 * `S6`'s.
 */

function make() {
  const clock = { now: 0 };
  const budget = new ForwardBudget({ now: () => clock.now });
  return { clock, budget };
}

function take(budget: ForwardBudget, kind: 'shared' | 'kept' | 'urgent', questions = 2): GaiToken {
  const token = budget.takeGai(kind, questions, {});
  assert.ok(token !== undefined, `a ${kind} token is free`);
  return token;
}

describe('the question budget’s tokens (P-432 S3)', () => {
  it('is built to the numbers decided: 5 shared, 1 kept, 2 urgent, held 10 s', () => {
    assert.deepEqual(GAI_TOKENS, { shared: 5, kept: 1, urgent: 2 });
    assert.equal(FORWARD_HOLD_MS, 10_000);
    assert.equal(questionsOf(0), 2, 'A and AAAA together');
    assert.equal(questionsOf(4), 1);
    assert.equal(questionsOf(6), 1);
  });

  it('gives each kind out until none is left, and never waits', () => {
    const { budget } = make();
    for (let n = 0; n < 5; n += 1) take(budget, 'shared');
    assert.equal(budget.takeGai('shared', 2, {}), undefined);
    take(budget, 'kept');
    assert.equal(budget.takeGai('kept', 2, {}), undefined);
    take(budget, 'urgent');
    take(budget, 'urgent');
    assert.equal(budget.takeGai('urgent', 2, {}), undefined);
    assert.deepEqual(budget.stats().held, { shared: 5, kept: 1, urgent: 2 });
    assert.equal(budget.questionsOpen(), 16, '8 tokens of family 0');
  });

  it('releases a token once, whatever is called twice (I9, L-F5)', () => {
    const { budget } = make();
    const token = take(budget, 'shared');
    budget.releaseGai(token);
    budget.releaseGai(token);
    assert.equal(token.released, true);
    assert.equal(budget.stats().released, 1);
    assert.equal(budget.available('shared'), 5);
    const forged = { kind: 'shared', questions: 2, holder: {}, released: false } as const;
    budget.releaseGai(forged);
    assert.equal(budget.stats().released, 1, 'a token it never gave out is nothing to it');
  });

  it('U takes shared tokens’ room, never the kept one’s or an urgent one’s', () => {
    const { budget } = make();
    const lanes = [{}, {}, {}, {}, {}];
    for (const lane of lanes) budget.untokenedStuck(lane, 2);
    budget.untokenedStuck(lanes[0] ?? {}, 2);
    assert.equal(budget.untokened(), 5, 'each lookup once');
    assert.equal(budget.available('shared'), 0);
    assert.equal(budget.available('kept'), 1);
    assert.equal(budget.available('urgent'), 2);
    budget.untokenedStuck({}, 2);
    assert.equal(budget.available('shared'), 0, 'never below none');
    assert.equal(budget.questionsOpen(), 12, 'each in U counted at the forwarder');
    budget.untokenedDone(lanes[0] ?? {});
    assert.equal(budget.untokened(), 5);
  });

  it('FB10: a stuck lookup lost leaves its token as a ghost of its own kind for 10 s', () => {
    const { budget, clock } = make();
    const kept = take(budget, 'kept');
    const urgent = take(budget, 'urgent');
    const shared = take(budget, 'shared', 1);
    budget.lose([
      { token: kept, stuck: true, started: true },
      { token: urgent, stuck: true, started: true },
      { token: shared, stuck: true, started: true },
    ]);
    assert.equal(kept.released, true, 'released into its ghost');
    assert.deepEqual(budget.stats().ghosts, { shared: 1, kept: 1, urgent: 1 });
    assert.equal(budget.available('kept'), 0, 'the kept ghost stays with the kept token');
    assert.equal(budget.available('urgent'), 1);
    assert.equal(budget.available('shared'), 4);
    assert.equal(budget.questionsOpen(), 5, 'counted once each, as its questions');
    clock.now = FORWARD_HOLD_MS - 1;
    assert.equal(budget.available('kept'), 0);
    clock.now = FORWARD_HOLD_MS;
    assert.equal(budget.available('kept'), 1, 'the forwarder has dropped them');
    assert.equal(budget.questionsOpen(), 0);
  });

  it('FB9: a lookup lost unstuck leaves a ledger ghost for 10 s that never reduces availability', () => {
    const { budget, clock } = make();
    const requeued = take(budget, 'shared');
    const never = take(budget, 'shared');
    budget.lose([
      { token: requeued, stuck: false, started: true },
      { token: never, stuck: false, started: false },
    ]);
    assert.equal(requeued.released, false, 'carried, for the lookup asked again');
    assert.equal(budget.stats().ledgerGhostQuestions, 2, 'only one that had started');
    assert.equal(budget.questionsOpen(), 6, 'two tokens held and the one ledger ghost');
    budget.releaseGai(requeued);
    budget.releaseGai(never);
    assert.equal(budget.available('shared'), 5, 'never in availability');
    assert.equal(budget.questionsOpen(), 2);
    clock.now = FORWARD_HOLD_MS;
    assert.equal(budget.questionsOpen(), 0);
  });

  it('Q5: a lookup asked again carries its token to its new holder', () => {
    const { budget } = make();
    const first = {};
    const token = budget.takeGai('shared', 2, first);
    assert.ok(token !== undefined);
    const again = {};
    budget.carry(token, again);
    assert.equal(token.holder, again);
    assert.deepEqual(budget.holders('shared'), [again]);
    budget.releaseGai(token);
    budget.carry(token, first);
    assert.deepEqual(budget.holders('shared'), [], 'a released token is nobody’s');
  });

  it('FB12: the peak since the last take, then from what is open', () => {
    const { budget, clock } = make();
    const a = take(budget, 'shared');
    const b = take(budget, 'shared');
    budget.untokenedStuck({}, 1);
    assert.equal(budget.stats().peak, 5);
    budget.releaseGai(a);
    budget.releaseGai(b);
    assert.equal(budget.questionsOpen(), 1);
    assert.equal(budget.takePeak(), 5, 'the highest since the start');
    assert.equal(budget.takePeak(), 1, 'since the take: what was open then');
    const c = take(budget, 'urgent');
    budget.lose([{ token: c, stuck: true, started: true }]);
    clock.now = FORWARD_HOLD_MS;
    assert.equal(budget.takePeak(), 3, 'a ghost gone counts while it was there');
    assert.equal(budget.takePeak(), 1);
  });
});
