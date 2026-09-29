import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { MigrationStatus } from '../src/db/migrator.js';
import { refuseSchema } from '../src/db/schema-gate.js';

/**
 * Whether this build may run against the schema it found (`H-03`).
 *
 * **The case worth having a test for is the downgrade**, because it is the one a pending-count
 * check cannot see: a build older than the database has *nothing* pending — the schema is past
 * it, not before it — so the check that was there before this ticket said everything was fine
 * while the process ran against tables it was never written for. That is also the likeliest of
 * the three in practice: rolling back a bad upgrade is exactly what an operator does at 3 a.m.
 */

const status = (over: Partial<MigrationStatus> = {}): MigrationStatus => ({
  applied: [],
  pending: [],
  drifted: [],
  unknown: [],
  ...over,
});

const migration = (id: number, name: string) => ({ id, name, up: '', down: '' });
const applied = (id: number, name: string) => ({
  id,
  name,
  checksum: 'x',
  appliedAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('the schema gate', () => {
  it('lets a matching schema through', () => {
    assert.equal(refuseSchema(status({ applied: [applied(1, 'object-model')] })), null);
  });

  it('refuses a schema this build is ahead of, and names what to run', () => {
    const refusal = refuseSchema(status({ pending: [migration(38, 'channel-limit-source')] }));
    assert.match(refusal ?? '', /migrate up/);
    assert.match(refusal ?? '', /38 channel-limit-source/, 'and which one comes next');
  });

  it('refuses a schema this build is behind, which is the downgrade', () => {
    // No pending migrations at all: everything this build knows is applied. The old check
    // passed here, and the process went on to run against a newer schema.
    const refusal = refuseSchema(
      status({
        applied: [applied(1, 'object-model')],
        unknown: [applied(38, 'channel-limit-source'), applied(39, 'something-later')],
      }),
    );
    assert.match(refusal ?? '', /newer ms-core/);
    assert.match(refusal ?? '', /39 something-later/, 'the newest, which is the one to match');
    assert.match(refusal ?? '', /restore a backup/, 'and the way out that does not lose data');
  });

  it('refuses a schema that has drifted from the record of it', () => {
    const refusal = refuseSchema(
      status({
        drifted: [{ id: 7, name: 'probe-identity', appliedChecksum: 'a', currentChecksum: 'b' }],
      }),
    );
    assert.match(refusal ?? '', /7 probe-identity \(applied a, this build b\)/);
    assert.match(refusal ?? '', /neither applying nor rolling back is safe/);
  });

  it('names five drifted migrations and counts the rest (P-238)', () => {
    const drifted = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
      id,
      name: `m${String(id)}`,
      appliedChecksum: `a${String(id)}`,
      currentChecksum: `c${String(id)}`,
    }));
    const refusal = refuseSchema(status({ drifted })) ?? '';
    assert.match(
      refusal,
      /^7 applied migration\(s\) no longer match this build: 1 m1 \(applied a1/,
    );
    assert.match(refusal, /5 m5 \(applied a5, this build c5\); and 2 more\./);
    assert.doesNotMatch(refusal, /m6/);
  });

  it('diagnoses a mismatched pair rather than sending them to migrate up', () => {
    // Both at once: some migrations shared with the database and some not, which is what a
    // half-finished upgrade or a mismatched pair of cores looks like. "Run migrate up" is the
    // first thing anybody would try and is wrong here — `migrate up` refuses this too — so the
    // message that names the newer core is the one that has to come out.
    const refusal = refuseSchema(
      status({
        pending: [migration(38, 'channel-limit-source')],
        unknown: [applied(99, 'from-the-future')],
      }),
    );
    assert.match(refusal ?? '', /newer ms-core/);
    assert.doesNotMatch(refusal ?? '', /migrate up/, 'which would send them round the loop');
  });

  it('diagnoses drift ahead of a pending migration (P-248)', () => {
    // A draft migration applied to a development database and edited before it landed, and the
    // next one pending: the gate said "run migrate up", and `migrate up` refused on the drift.
    const refusal = refuseSchema(
      status({
        pending: [migration(60, 'next')],
        drifted: [{ id: 59, name: 'sensor-voucher', appliedChecksum: 'a', currentChecksum: 'b' }],
      }),
    );
    assert.match(refusal ?? '', /^1 applied migration\(s\) no longer match this build: 59 /u);
    assert.doesNotMatch(refusal ?? '', /migrate up/u);
  });

  it('diagnoses drift ahead of a newer schema, as migrate up does (P-248)', () => {
    const refusal = refuseSchema(
      status({
        drifted: [{ id: 59, name: 'sensor-voucher', appliedChecksum: 'a', currentChecksum: 'b' }],
        unknown: [applied(61, 'from-the-future')],
      }),
    );
    assert.match(refusal ?? '', /no longer match this build/u);
    assert.doesNotMatch(refusal ?? '', /newer ms-core/u);
  });

  it('says "migrate up" in exactly the one case where migrate up would apply something', () => {
    // Every combination of the three ways to be wrong. `Migrator.up()` refuses drift, then a
    // newer schema, and only then applies, so the advice is right only for pending alone.
    const drift = { id: 7, name: 'probe-identity', appliedChecksum: 'a', currentChecksum: 'b' };
    for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const shape = {
        drifted: mask & 1 ? [drift] : [],
        unknown: mask & 2 ? [applied(99, 'from-the-future')] : [],
        pending: mask & 4 ? [migration(38, 'channel-limit-source')] : [],
      };
      const refusal = refuseSchema(status(shape));
      const expected =
        mask === 0
          ? null
          : mask & 1
            ? /no longer match this build/u
            : mask & 2
              ? /newer ms-core/u
              : /run "ms-core migrate up"/u;
      if (expected === null) {
        assert.equal(refusal, null, 'nothing wrong');
        continue;
      }
      assert.match(refusal ?? '', expected, `for ${JSON.stringify(shape)}`);
      assert.equal(/migrate up/u.test(refusal ?? ''), mask === 4, `for ${JSON.stringify(shape)}`);
    }
  });
});
