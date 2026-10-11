import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { QueryResultRow } from 'pg';
import type { Queryable } from '../src/db/pool.js';
import { sessionsWait, somebodyWaits } from './support/waits-for-lock.js';
import { pollWithin } from './support/within.js';

// `P-325`: a poll handed to `within` went on polling after `within` gave up on it — into the
// cleanup that was closing its pool, and for ever if the condition never came true. Each case
// that expects the polls to stop lets them end once it has looked (`settle`), so a helper that
// does not stop fails here rather than keeping this file's process alive.

describe('pollWithin', () => {
  it('answers once the condition is met, and asks no more', async () => {
    let polls = 0;
    await pollWithin(
      5_000,
      'the third poll',
      () => {
        polls += 1;
        return polls === 3;
      },
      5,
    );
    assert.equal(polls, 3);
    await sleep(60);
    assert.equal(polls, 3, 'it polled again after it had answered');
  });

  it('fails at its bound naming what it waited for, and polls no more after it', async () => {
    let polls = 0;
    let settle = false;
    try {
      await assert.rejects(
        pollWithin(
          100,
          'a condition that never comes true',
          () => {
            polls += 1;
            return settle;
          },
          5,
        ),
        /timed out after 100 ms waiting for a condition that never comes true/,
      );
      const atTheBound = polls;
      assert.ok(atTheBound > 1, `it polled ${String(atTheBound)} times before its bound`);
      await sleep(250);
      assert.equal(polls, atTheBound, 'it went on polling after its bound');
    } finally {
      settle = true;
    }
  });

  it('lets a poll that is out at the bound finish, and starts none after it', async () => {
    let started = 0;
    let finished = 0;
    let settle = false;
    try {
      await assert.rejects(
        pollWithin(
          50,
          'a slow poll',
          async () => {
            started += 1;
            await sleep(150);
            finished += 1;
            return settle;
          },
          5,
        ),
        /timed out after 50 ms waiting for a slow poll/,
      );
      assert.equal(started, 1);
      await sleep(400);
      assert.equal(finished, 1, 'the poll that was out did not finish');
      assert.equal(started, 1, 'another poll started after the bound');
    } finally {
      settle = true;
    }
  });

  it('passes on a poll that fails', async () => {
    await assert.rejects(
      pollWithin(5_000, 'a poll that throws', () => {
        throw new Error('the query failed');
      }),
      /the query failed/,
    );
  });
});

describe('somebodyWaits', () => {
  /** A database whose `pg_stat_activity` reports `waiting(i)` sessions waiting on the i-th ask. */
  const reporting = (
    waiting: (ask: number) => number,
  ): { db: Pick<Queryable, 'query'>; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      db: {
        query: <T extends QueryResultRow>(text: string): Promise<T[]> => {
          asked.push(text);
          return Promise.resolve([{ n: waiting(asked.length) } as unknown as T]);
        },
      },
    };
  };

  it('answers once a session waits on a lock', async () => {
    const { db, asked } = reporting((ask) => (ask === 3 ? 1 : 0));
    await somebodyWaits(db, 'the other side', 5_000, 5);
    assert.equal(asked.length, 3);
    for (const text of asked) {
      assert.match(text, /FROM pg_stat_activity/);
      assert.match(text, /wait_event_type = 'Lock'/);
      assert.match(text, /datname = current_database\(\)/);
    }
  });

  it('fails at its bound and asks the database no more after it', async () => {
    let settle = false;
    const { db, asked } = reporting(() => (settle ? 1 : 0));
    try {
      await assert.rejects(
        somebodyWaits(db, 'nobody at all', 100, 5),
        /timed out after 100 ms waiting for nobody at all/,
      );
      const atTheBound = asked.length;
      assert.ok(atTheBound > 1, `it asked ${String(atTheBound)} times before its bound`);
      await sleep(250);
      assert.equal(asked.length, atTheBound, 'it went on asking after its bound');
    } finally {
      settle = true;
    }
  });
});

describe('sessionsWait', () => {
  /** A database that reports `waiting(i)` sessions on the i-th ask, and keeps what it was asked. */
  const reporting = (
    waiting: (ask: number) => number,
  ): { db: Pick<Queryable, 'query'>; asked: unknown[][] } => {
    const asked: unknown[][] = [];
    return {
      asked,
      db: {
        query: <T extends QueryResultRow>(_text: string, values: unknown[] = []): Promise<T[]> => {
          asked.push(values);
          return Promise.resolve([{ n: waiting(asked.length) } as unknown as T]);
        },
      },
    };
  };

  it('answers only once as many sessions as it was asked for wait (P-395)', async () => {
    const { db, asked } = reporting((ask) => Math.min(ask - 1, 2));
    await sessionsWait(db, 2, 'both requests', { intervalMs: 5 });
    assert.equal(asked.length, 3, 'it answered before the second session waited');
    assert.deepEqual(asked[0], [null], 'any lock, when no event is named');
  });

  it('asks for the one wait event it is given (P-396)', async () => {
    const { db, asked } = reporting(() => 1);
    await sessionsWait(db, 1, 'the tree lock', { event: 'advisory', intervalMs: 5 });
    assert.deepEqual(asked, [['advisory']]);
  });

  it('says at its bound how many it wanted, on what, and how many it saw', async () => {
    let settle = false;
    const { db } = reporting(() => (settle ? 2 : 1));
    try {
      await assert.rejects(
        sessionsWait(db, 2, 'both requests', { ms: 100, intervalMs: 5, event: 'advisory' }),
        /timed out after 100 ms waiting for both requests \(2 waiting on a lock \(advisory\); 1 seen last\)/,
      );
    } finally {
      settle = true;
    }
  });
});
