import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Visibility, type AccessPrincipal } from '../src/auth/access.js';
import type { Queryable } from '../src/db/pool.js';
import { scheduledSight, type ScheduledSightOptions } from '../src/discovery/provision.js';
import type { StoredVoucher } from '../src/objects/vouching.js';

/**
 * Whose sight a pass a schedule fires has (`A-82`), for every kind of rule writer. What the sight
 * then does to a pass is `object-visibility.test.ts`, through the real routes.
 */

const GROUP = 40;
const SEEN = 41;
const HIDDEN = 42;

/** An account's grants: write on the group and one device, nothing on the other. */
const rights = (
  _principal: AccessPrincipal,
  objectIds: readonly number[],
): Promise<ReadonlyMap<number, 'write' | 'none'>> =>
  Promise.resolve(new Map(objectIds.map((id) => [id, id === HIDDEN ? 'none' : 'write'])));

function options(
  writer: StoredVoucher | null,
  account: { role: string; disabled: boolean } | undefined,
  authRequired = true,
): { options: ScheduledSightOptions; asked: AccessPrincipal[] } {
  const asked: AccessPrincipal[] = [];
  return {
    asked,
    options: {
      authRequired,
      ruleWriter: () => Promise.resolve(writer),
      db: {
        query: () => Promise.resolve(account === undefined ? [] : [account]),
      } as unknown as Queryable,
      visibilityFor: (principal) => {
        asked.push(principal);
        return Promise.resolve(Visibility.of(new Map([[GROUP, true]]), false, 7));
      },
      rights,
    },
  };
}

const q = {} as Queryable;

async function sees(
  scheduleId: number | null,
  given: ReturnType<typeof options>,
): Promise<{ group: boolean; writes: number[]; whole: boolean }> {
  const sight = await scheduledSight(scheduleId, given.options);
  return {
    group: sight.visibility !== Visibility.EVERYTHING && sight.visibility.epoch === 7,
    writes: (await sight.writes.split(q, [GROUP, SEEN, HIDDEN])).reached,
    whole: sight.visibility === Visibility.EVERYTHING,
  };
}

describe('whose sight a scheduled pass has (`A-82`)', () => {
  const account: StoredVoucher = { kind: 'account', userId: 5 };

  it('is the writer’s, resolved as a request of theirs would be', async () => {
    const given = options(account, { role: 'readwrite', disabled: false });
    assert.deepEqual(await sees(9, given), { group: true, writes: [GROUP, SEEN], whole: false });
    assert.deepEqual(given.asked, [{ userId: 5, role: 'readwrite' }]);
  });

  it('is the installation’s for a rule the installation wrote, or with the layer off', async () => {
    const whole = { group: false, writes: [GROUP, SEEN, HIDDEN], whole: true };
    assert.deepEqual(await sees(9, options({ kind: 'installation' }, undefined)), whole);
    assert.deepEqual(
      await sees(9, options(account, { role: 'readwrite', disabled: false }, false)),
      whole,
    );
  });

  const NONE: readonly {
    name: string;
    scheduleId: number | null;
    writer: StoredVoucher | null;
    account?: { role: string; disabled: boolean };
  }[] = [
    { name: 'a writer since deleted', scheduleId: 9, writer: account },
    {
      name: 'a writer disabled',
      scheduleId: 9,
      writer: account,
      account: { role: 'admin', disabled: true },
    },
    { name: 'a writer never recorded', scheduleId: 9, writer: { kind: 'account', userId: null } },
    { name: 'a rule since deleted', scheduleId: 9, writer: null },
    { name: 'a run with no rule', scheduleId: null, writer: account },
  ];
  for (const row of NONE) {
    it(`is nothing at all for ${row.name}`, async () => {
      const given = options(row.writer, row.account);
      const sight = await scheduledSight(row.scheduleId, given.options);
      assert.equal(
        sight.visibility.where('id', () => '$1'),
        'FALSE',
        'it sees nothing',
      );
      assert.deepEqual((await sight.writes.split(q, [GROUP, SEEN])).reached, []);
      assert.deepEqual(given.asked, [], 'nobody’s grants were asked');
    });
  }
});
