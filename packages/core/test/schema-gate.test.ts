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
    assert.match(refusal ?? '', /7 probe-identity/);
    assert.match(refusal ?? '', /neither applying nor rolling back is safe/);
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
});
