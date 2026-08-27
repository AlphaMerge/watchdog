import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ProbeRegistry } from '../src/probes/registry.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';

/**
 * Which probes an installation trusts (`R-01`).
 *
 * **The claims worth testing are all about what a probe is *not* given.** That a machine which
 * reaches the port is recorded rather than trusted, that a revoked identity cannot come back by
 * reconnecting, that a key is issued once and never readable again, and that an address filter
 * narrows rather than widens. Against a real database, because every one of those is a claim
 * about a row and a stub would agree with whatever the code did.
 */

const available = await databaseAvailable();

describe('the probe registry', { skip: available ? false : 'no database' }, () => {
  let scratch: ScratchDatabase;
  let db: Database;
  let harness: Awaited<ReturnType<typeof buildHarness>>;
  let registry: ProbeRegistry;
  let probeId = 0;

  before(async () => {
    scratch = await createScratchDatabase('probe_registry');
    db = scratch.db;
    harness = await buildHarness(db);
  });

  after(async () => {
    await scratch.drop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM probe_registration');
    await db.query('DELETE FROM object WHERE parent_id IS NOT NULL');
    registry = new ProbeRegistry({ db, logger: silentLogger, enrolmentKeys: ['shared-key'] });
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
  });

  const hello = (over: Partial<Parameters<ProbeRegistry['admit']>[0]> = {}) => ({
    gid: '',
    displayName: 'backup-01',
    agentVersion: '0.1.0',
    protocolVersion: 6,
    accessKey: 'shared-key',
    remoteAddress: '10.4.2.9',
    ...over,
  });

  describe('a probe nobody has seen', () => {
    it('is recorded and given nothing', async () => {
      const decision = await registry.admit(hello());
      assert.ok(decision.kind === 'pending');
      assert.notEqual(decision.gid, '', 'and it is given an identity to come back with');

      const stored = await registry.get(decision.gid);
      assert.ok(stored !== null);
      assert.equal(stored.status, 'pending');
      assert.equal(stored.displayName, 'backup-01');
      assert.equal(stored.lastAddress, '10.4.2.9', 'shown beside the decision an operator makes');
      assert.equal(stored.objectId, null, 'and it owns no branch of the tree');
      assert.equal(stored.hasOwnKey, false);
    });

    it('is refused without the enrolment key, and leaves no row', async () => {
      const decision = await registry.admit(hello({ accessKey: 'wrong' }));
      assert.ok(decision.kind === 'refused');
      assert.equal(decision.code, 'bad-access-key');
      assert.equal((await registry.list()).length, 0, 'a wrong key does not fill the queue');
    });

    it('keeps the identity it offered rather than inventing a second one', async () => {
      // A rebuilt core, a restored backup, a copied config: the probe will keep presenting this
      // GID, so recording it under a fresh one would put two rows in the queue for one machine.
      const decision = await registry.admit(hello({ gid: 'from-a-restored-backup' }));
      assert.ok(decision.kind === 'pending');
      assert.equal(decision.gid, 'from-a-restored-backup');
    });

    it('accepts any key when the installation has set none', async () => {
      // The shipped development default. Only reasonable on a trusted network, and said out
      // loud rather than left as a surprise.
      const open = new ProbeRegistry({ db, logger: silentLogger, enrolmentKeys: [] });
      assert.equal((await open.admit(hello({ accessKey: '' }))).kind, 'pending');
    });
  });

  describe('a probe that is still waiting', () => {
    it('stays pending however often it comes back', async () => {
      // What a probe waiting for approval does is reconnect, every few seconds, for as long as
      // it takes somebody to look. Reading the second hello as approval would mean approval by
      // persistence. Found by a mutation: nothing tested the *returning* pending probe.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');

      const again = await registry.admit(hello({ gid: first.gid }));
      assert.equal(again.kind, 'pending');
      assert.equal((await registry.get(first.gid))?.status, 'pending');
    });

    it('is refused if it comes back with the wrong key', async () => {
      // It has no key of its own yet, so it presents the shared one — and a machine that gets
      // that wrong is not the machine that enrolled.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      const again = await registry.admit(hello({ gid: first.gid, accessKey: 'wrong' }));
      assert.ok(again.kind === 'refused');
      assert.equal(again.code, 'bad-access-key');
    });
  });

  describe('approving', () => {
    it('binds it to a branch and issues a key it never returns again', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');

      await registry.approve(first.gid, probeId);

      const afterApproval = await registry.get(first.gid);
      assert.ok(afterApproval !== null);
      assert.equal(afterApproval.status, 'approved');
      assert.equal(afterApproval.objectId, probeId);
      // **No key yet.** Approving a machine that is switched off is an ordinary thing to do, and
      // a key delivered in a welcome it never received would lock it out — so the key is minted
      // at the next handshake instead. Found by revoking and re-approving a live probe.
      assert.equal(afterApproval.hasOwnKey, false);

      const back = await registry.admit(hello({ gid: first.gid }));
      assert.ok(back.kind === 'approved');
      const accessKey = back.issuedKey;
      assert.ok(accessKey !== undefined && accessKey.length >= 32, 'issued in that welcome');

      const stored = await registry.get(first.gid);
      assert.ok(stored !== null);
      assert.equal(stored.hasOwnKey, true);
      assert.ok(
        !JSON.stringify(stored).includes(accessKey),
        'and the key itself is nowhere in what a route can read',
      );

      // Exactly once: the next handshake takes the issued-key path.
      const third = await registry.admit(hello({ gid: first.gid, accessKey }));
      assert.ok(third.kind === 'approved');
      assert.equal(third.issuedKey, undefined);

      // The tree's own side of the binding, so `R-04`'s config push finds the subtree.
      const rows = await db.query<{ gid: string }>(
        'SELECT gid FROM probe_config WHERE object_id = $1',
        [probeId],
      );
      assert.equal(rows[0]?.gid, first.gid);
    });

    it('lets an approved probe in with its own key, and nothing else', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;

      const good = await registry.admit(hello({ gid: first.gid, accessKey }));
      assert.ok(good.kind === 'approved');
      assert.equal(good.objectId, probeId);

      // **The shared key stops working for this probe once it has one of its own**, which is
      // the whole point: revoking one machine must not mean rotating everybody's key.
      const shared = await registry.admit(hello({ gid: first.gid, accessKey: 'shared-key' }));
      assert.equal(shared.kind, 'refused');
    });

    it('refuses to put two identities on one branch', async () => {
      // Both would be told to scan the same sensors, which is the duplicate-alarm failure
      // "one outage, one alarm" exists to prevent.
      const first = await registry.admit(hello());
      const second = await registry.admit(hello({ gid: 'another-machine' }));
      assert.ok(first.kind === 'pending' && second.kind === 'pending');
      await registry.approve(first.gid, probeId);

      await assert.rejects(
        () => registry.approve(second.gid, probeId),
        (error: unknown) => error instanceof Error && /already belongs to/.test(error.message),
      );
    });

    it('reports a probe that is not there', async () => {
      await assert.rejects(
        () => registry.approve('never-seen', probeId),
        (error: unknown) => error instanceof Error && /there is no probe/.test(error.message),
      );
    });
  });

  describe('revoking', () => {
    it('refuses it from then on, and keeps the record', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;

      await registry.revoke(first.gid, 'the machine was decommissioned');

      const back = await registry.admit(hello({ gid: first.gid, accessKey }));
      assert.ok(back.kind === 'refused');
      assert.equal(back.code, 'revoked');
      assert.match(back.detail, /decommissioned/, 'the operator’s own sentence comes back');

      const stored = await registry.get(first.gid);
      assert.ok(stored !== null);
      assert.equal(stored.status, 'revoked', 'kept, so it cannot return by reconnecting');
      assert.equal(stored.hasOwnKey, false, 'and its key is gone');
    });

    it('releases the branch, because the sensors outlive the machine', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      await registry.revoke(first.gid, '');

      const rows = await db.query<{ gid: string | null }>(
        'SELECT gid FROM probe_config WHERE object_id = $1',
        [probeId],
      );
      assert.equal(rows[0]?.gid, null, 'so a replacement machine can be bound to it');
    });

    it('forgets one entirely, and it then enrols as a stranger', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      assert.equal(await registry.remove(first.gid), true);
      assert.equal(await registry.remove(first.gid), false, 'and only once');

      const again = await registry.admit(hello({ gid: first.gid }));
      assert.equal(again.kind, 'pending');
    });
  });

  describe('where a probe may connect from', () => {
    it('refuses an approved probe from outside its filter', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.4.0.0/16']);

      assert.equal(
        (await registry.admit(hello({ gid: first.gid, accessKey, remoteAddress: '10.4.2.9' })))
          .kind,
        'approved',
      );
      const outside = await registry.admit(
        hello({ gid: first.gid, accessKey, remoteAddress: '192.0.2.7' }),
      );
      assert.ok(outside.kind === 'refused');
      assert.equal(outside.code, 'source-not-allowed');
    });

    it('allows anywhere when nobody has said otherwise', async () => {
      // An allowlist nobody wrote is not a mistake: a default of "nothing may connect" would
      // refuse the first probe for being the first.
      const first = await registry.admit(hello({ remoteAddress: '203.0.113.4' }));
      assert.equal(first.kind, 'pending');
    });

    it('refuses a filter that will not parse, with the parser’s own sentence', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await assert.rejects(
        () => registry.setAllowFrom(first.gid, ['10.0.0.0/33']),
        (error: unknown) => error instanceof Error && /prefix longer than 32 bits/.test(error.message),
      );
    });

    it('refuses an address the filter cannot express at all', async () => {
      // An IPv6 peer against a list of IPv4 ranges. The filter cannot say yes to something it
      // cannot describe, and refusing is the only answer that keeps it meaning what it says.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.0.0.0/8']);

      const v6 = await registry.admit(
        hello({ gid: first.gid, accessKey, remoteAddress: '2001:db8::1' }),
      );
      assert.ok(v6.kind === 'refused');
      assert.equal(v6.code, 'source-not-allowed');
    });

    it('includes a CIDR’s network and broadcast addresses, unlike a sweep range', async () => {
      // The documented difference from `parseIpRange`: excluding `.0` and `.255` is a statement
      // about which addresses answer a ping, which is true for a sweep and meaningless for
      // "may this identity connect from here". A probe really can sit on `10.0.0.0/31`.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.9.0.0/24']);

      for (const address of ['10.9.0.0', '10.9.0.255', '10.9.0.17']) {
        assert.equal(
          (await registry.admit(hello({ gid: first.gid, accessKey, remoteAddress: address }))).kind,
          'approved',
          `${address} is inside 10.9.0.0/24`,
        );
      }
    });

    it('takes a range too large to enumerate, because it is a permission not a sweep', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      const after = await registry.setAllowFrom(first.gid, ['10.0.0.0/8']);
      assert.deepEqual(after.allowFrom, ['10.0.0.0/8']);
    });
  });

  describe('the local probe', () => {
    it('cannot be deleted', async () => {
      // Matching PRTG. Deleting it leaves a core whose own host is unmonitored and no obvious
      // route back: the probe process is still running and still connecting, but the branch it
      // was approved onto is gone, so it enrols again as a stranger and every sensor that lived
      // under it went with the subtree.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, { local: true });

      await assert.rejects(
        () => harness.service.delete(testActor, probeId, { kind: 'leafOnly' }, { kind: 'none' }),
        (error: unknown) =>
          error instanceof Error && /local probe and cannot be deleted/.test(error.message),
      );
      assert.notEqual(await harness.service.get(probeId), null);
    });

    it('is only local when somebody said so', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId);
      const report = await harness.service.delete(
        testActor,
        probeId,
        { kind: 'leafOnly' },
        { kind: 'none' },
      );
      assert.equal(report.id, probeId);
    });

    it('stays local when it is approved again', async () => {
      // Replacing the machine beside the core is a re-approval, and it must not quietly make
      // the branch deletable.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, { local: true });
      await registry.revoke(first.gid, 'the machine was replaced');

      const second = await registry.admit(hello({ gid: 'the-replacement' }));
      assert.ok(second.kind === 'pending');
      await registry.approve(second.gid, probeId);

      const rows = await db.query<{ is_local: boolean }>(
        'SELECT is_local FROM probe_config WHERE object_id = $1',
        [probeId],
      );
      assert.equal(rows[0]?.is_local, true);
    });
  });

  describe('what it records', () => {
    it('updates what a returning probe says about itself', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.admit(
        hello({ gid: first.gid, displayName: 'renamed-01', agentVersion: '0.2.0', remoteAddress: '10.4.9.9' }),
      );

      const stored = await registry.get(first.gid);
      assert.ok(stored !== null);
      assert.equal(stored.displayName, 'renamed-01');
      assert.equal(stored.agentVersion, '0.2.0');
      assert.equal(stored.lastAddress, '10.4.9.9');
      assert.notEqual(stored.lastSeenAt, null);
    });

    it('records a refused attempt rather than losing it', async () => {
      // "Why is backup-01 not scanning" is answered by the row that says a revoked identity
      // tried at 04:12 from an address nobody recognises. A refusal that left no trace is the
      // one that takes a day to find.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.revoke(first.gid, 'no longer ours');
      await registry.admit(hello({ gid: first.gid, remoteAddress: '198.51.100.3' }));

      const stored = await registry.get(first.gid);
      assert.equal(stored?.lastAddress, '198.51.100.3');
    });

    it('lists by status, so the queue is one query', async () => {
      const first = await registry.admit(hello());
      const second = await registry.admit(hello({ gid: 'second-machine' }));
      assert.ok(first.kind === 'pending' && second.kind === 'pending');
      await registry.approve(first.gid, probeId);

      assert.deepEqual(
        (await registry.list('pending')).map((one) => one.gid),
        [second.gid],
      );
      assert.equal((await registry.list()).length, 2);
    });
  });
});
