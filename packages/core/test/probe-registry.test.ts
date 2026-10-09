import { strict as assert } from 'node:assert';
import { Ajv } from 'ajv';
import Fastify from 'fastify';
import { DatabaseAuditSink } from '../src/audit/store.js';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createLogger, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, withCorrelation } from '@ms/shared';
import { ProbeHealthService, withLastRefusal } from '../src/health/probe-health.js';
import { ProbeRegistry } from '../src/probes/registry.js';
import { probeRoutes } from '../src/api/routes/probes.js';
import { API_VALIDATOR_OPTIONS } from '../src/api/server.js';
import { IN_PROCESS_SOURCES } from '../src/ingestion/sources.js';
import type { Database } from '../src/db/pool.js';
import {
  createScratchDatabase,
  databaseAvailable,
  silentLogger,
  type ScratchDatabase,
} from './support/database.js';
import { buildHarness, testActor } from './support/tree.js';
import { everyVoucherHolds } from './support/vouching.js';

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
    registry = new ProbeRegistry({
      db,
      audit: new DatabaseAuditSink(),
      logger: silentLogger,
      enrolmentKeys: ['shared-key'],
    });
    const probe = await harness.service.create(testActor, {
      kind: 'probe',
      parentId: harness.rootId,
      name: `probe-${String(process.hrtime.bigint())}`,
    });
    probeId = probe.id;
  });

  /**
   * A stand-in for the transport, recording what a decision would have done to a live link.
   *
   * `connectedFrom` is the transport's one contribution to an address-filter decision: where the
   * probe actually is. `null` stands for a probe that is not connected at all.
   */
  function recorder(connectedFrom: string | null = null) {
    const closed: { gid: string; reason: string }[] = [];
    const withdrawn: { gid: string; code: string; detail: string }[] = [];
    return {
      closed,
      withdrawn,
      disconnect: (gid: string, reason: string) => {
        closed.push({ gid, reason });
        return true;
      },
      withdraw: (gid: string, code: string, detail: string) => {
        withdrawn.push({ gid, code, detail });
        return connectedFrom !== null;
      },
      remoteAddressOf: () => connectedFrom,
    };
  }

  const hello = (over: Partial<Parameters<ProbeRegistry['admit']>[0]> = {}) => ({
    gid: '',
    displayName: 'backup-01',
    agentVersion: '0.1.0',
    // This build's own version, not a literal: a hardcoded number here turns every protocol bump
    // into a test that fails for the wrong reason, which is exactly the "a number nobody looks
    // at" problem `R-06` moved the version table for.
    protocolVersion: PROTOCOL_VERSION,
    accessKey: 'shared-key',
    remoteAddress: '10.4.2.9',
    ...over,
  });

  describe('a decision reaching a connection', () => {
    it('closes the probe’s connection when it is approved', async () => {
      // **`P-189`.** The rows are only half of a decision. `session.approved` is fixed at
      // admission, so approving a probe that connected while pending changed nothing it could
      // observe — it kept scanning nothing until something else made it reconnect.
      const link = recorder();
      registry.attach(link);
      const closed = link.closed;

      await registry.admit(hello({ gid: 'reconnecting-probe' }));
      await registry.approve('reconnecting-probe', probeId, testActor);

      assert.equal(closed.length, 1);
      const only = closed[0];
      assert.ok(only !== undefined);
      assert.equal(only.gid, 'reconnecting-probe');
      // The reason reaches the probe's log, which is where somebody wondering why it dropped
      // will look.
      assert.match(only.reason, /reconnect/);
    });

    it('decides perfectly well with nothing attached', async () => {
      // Absent is a legitimate state: every test that only cares what the rows say, and every
      // deployment before the endpoint exists.
      const detached = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        enrolmentKeys: [],
      });
      await detached.admit(hello({ gid: 'unwatched-probe', accessKey: '' }));
      const approved = await detached.approve('unwatched-probe', probeId, testActor);
      assert.equal(approved.status, 'approved');
    });
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

    it('will not enrol a probe under a name the core reports its own results under', async () => {
      // `P-228`. The Sensor Factory, Core Health and Probe Health report through the trusted
      // path under these names. A probe called `factory` could not borrow that trust — a probe's
      // batch goes through the ownership gate whatever it is called — but it would read as the
      // factory in every log line and share its pacing. It is enrolled under a fresh identity,
      // which the welcome carries and the probe keeps.
      for (const reserved of IN_PROCESS_SOURCES) {
        const decision = await registry.admit(hello({ gid: reserved }));
        assert.ok(decision.kind === 'pending');
        assert.notEqual(decision.gid, reserved);
        assert.match(decision.gid, /^[0-9a-f]{32}$/u, 'minted, as for a probe that offered none');
      }
      const listed = await registry.list();
      assert.ok(!listed.some((one) => IN_PROCESS_SOURCES.has(one.gid)), 'and none is recorded');
    });

    it('accepts any key when the installation has set none', async () => {
      // The shipped development default. Only reasonable on a trusted network, and said out
      // loud rather than left as a surprise.
      const open = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        enrolmentKeys: [],
      });
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

      await registry.approve(first.gid, probeId, testActor);

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
      // **Issued is not the same as held** (`P-37`). `hasOwnKey` used to read "a hash exists",
      // and flipping it here meant the enrolment fallback closed on a probe that might never
      // have received the welcome. It now means the probe has *used* the key, so it is still
      // false at this point and the change is deliberate rather than incidental.
      assert.equal(stored.hasOwnKey, false, 'issued, not yet proven to have arrived');
      assert.ok(
        !JSON.stringify(stored).includes(accessKey),
        'and the key itself is nowhere in what a route can read',
      );

      // The next handshake with that key takes the issued-key path, and confirms it.
      const third = await registry.admit(hello({ gid: first.gid, accessKey }));
      assert.ok(third.kind === 'approved');
      assert.equal(third.issuedKey, undefined);

      const confirmed = await registry.get(first.gid);
      assert.equal(confirmed?.hasOwnKey, true, 'used, so now it is the probe’s own key');

      // The tree's own side of the binding, so `R-04`'s config push finds the subtree.
      const rows = await db.query<{ gid: string }>(
        'SELECT gid FROM probe_config WHERE object_id = $1',
        [probeId],
      );
      assert.equal(rows[0]?.gid, first.gid);
    });

    /**
     * The window between the core writing a key down and the probe having it (`P-37`).
     *
     * The core stores the hash and returns the key in the welcome that follows, and nothing
     * acknowledges it. A link that drops in between — or a probe killed, or a spool directory
     * that cannot be written — used to leave the core rotated and the probe not, and the probe
     * came back on the only key it had and was refused for ever.
     */
    it('takes a probe back on the enrolment key when the welcome never arrived', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      // The handshake that issues a key. Pretend the welcome is lost: the probe never sees
      // `issuedKey`, so it still holds nothing but the enrolment key.
      const issuing = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issuing.kind === 'approved');
      assert.ok(issuing.issuedKey !== undefined, 'a key was minted and written down');

      // What the probe can actually do next: reconnect with the enrolment key it started with.
      const retry = await registry.admit(hello({ gid: first.gid }));
      assert.ok(
        retry.kind === 'approved',
        `a probe that never got its key must not be locked out, got ${retry.kind}`,
      );
      assert.ok(retry.issuedKey !== undefined, 'and it is issued another one, since it has none');
      assert.notEqual(retry.issuedKey, issuing.issuedKey, 'a fresh key, not the lost one');

      // This time the welcome lands, and using the key closes the fallback.
      const settled = await registry.admit(hello({ gid: first.gid, accessKey: retry.issuedKey }));
      assert.ok(settled.kind === 'approved');
      assert.equal(settled.issuedKey, undefined, 'it has one of its own now');
      assert.equal((await registry.get(first.gid))?.hasOwnKey, true);
    });

    it('stops accepting the enrolment key once the probe has used its own', async () => {
      // **The security half, and the reason the fallback is bounded by use rather than by a
      // clock.** An enrolment key is shared and long-lived; once a probe has a key of its own,
      // presenting the shared one must not impersonate it. The window above is open only while
      // the probe demonstrably has nothing else.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      const issuing = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issuing.kind === 'approved' && issuing.issuedKey !== undefined);
      const used = await registry.admit(hello({ gid: first.gid, accessKey: issuing.issuedKey }));
      assert.ok(used.kind === 'approved');

      const onEnrolmentKey = await registry.admit(hello({ gid: first.gid }));
      assert.equal(onEnrolmentKey.kind, 'refused', 'the shared key is no longer enough');
    });

    it('lets an approved probe in with its own key, and nothing else', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);
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
      await registry.approve(first.gid, probeId, testActor);

      await assert.rejects(
        () => registry.approve(second.gid, probeId, testActor),
        (error: unknown) => error instanceof Error && /already belongs to/.test(error.message),
      );
    });

    it('reports a probe that is not there', async () => {
      await assert.rejects(
        () => registry.approve('never-seen', probeId, testActor),
        (error: unknown) => error instanceof Error && /there is no probe/.test(error.message),
      );
    });
  });

  describe('revoking', () => {
    it('refuses it from then on, and keeps the record', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;

      await registry.revoke(first.gid, 'the machine was decommissioned', testActor);

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
      await registry.approve(first.gid, probeId, testActor);
      await registry.revoke(first.gid, '', testActor);

      const rows = await db.query<{ gid: string | null }>(
        'SELECT gid FROM probe_config WHERE object_id = $1',
        [probeId],
      );
      assert.equal(rows[0]?.gid, null, 'so a replacement machine can be bound to it');
    });

    it('forgets one entirely, and it then enrols as a stranger', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      assert.equal(await registry.remove(first.gid, testActor), true);
      assert.equal(await registry.remove(first.gid, testActor), false, 'and only once');

      const again = await registry.admit(hello({ gid: first.gid }));
      assert.equal(again.kind, 'pending');
    });
  });

  describe('withdrawing trust from a probe that is connected', () => {
    // **`P-189` closed the approval half of this and left the other three.** `revoke`, `remove`
    // and a narrowed `allow-from` all wrote their rows and told the live connection nothing, so
    // the refusal only bit at a handshake that might be hours away. Worse than the approval case
    // it mirrors: a probe that merely loses the core keeps checking and spools to disk, so the
    // machine an operator had just refused went on probing their network.

    it('carries the operator’s own sentence, not the word “revoked”', async () => {
      // A probe journal that says "revoked" tells whoever reads it nothing they did not already
      // know. The note is the only place the reason exists, and it is the same sentence `admit`
      // sends at a refused handshake — so a probe refused live and one refused on reconnect are
      // told the same thing.
      const link = recorder('10.4.2.9');
      registry.attach(link);
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);
      assert.deepEqual(link.withdrawn, [], 'approving is not withdrawing');

      await registry.revoke(first.gid, 'decommissioned, replaced by web-dc4', testActor);
      assert.deepEqual(link.withdrawn, [
        { gid: first.gid, code: 'revoked', detail: 'decommissioned, replaced by web-dc4' },
      ]);
    });

    it('falls back to the sentence a refused handshake would have used', async () => {
      const link = recorder('10.4.2.9');
      registry.attach(link);
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');

      await registry.revoke(first.gid, '', testActor);
      assert.deepEqual(link.withdrawn, [
        { gid: first.gid, code: 'revoked', detail: 'this probe has been revoked' },
      ]);
    });

    it('stops a forgotten probe too, which is the least accountable case', async () => {
      // Deleting the row says "this machine is gone". Said about one still connected, it would
      // leave a probe checking devices under assignments the core no longer has any record of
      // giving it. `not-approved`, because that is what it now is.
      const link = recorder('10.4.2.9');
      registry.attach(link);
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      assert.equal(await registry.remove(first.gid, testActor), true);
      assert.deepEqual(link.withdrawn, [
        {
          gid: first.gid,
          code: 'not-approved',
          detail: 'this probe is no longer registered with this core',
        },
      ]);
    });

    it('says nothing about a probe that was never there', async () => {
      // `remove` answers false for a GID it did not delete, and must not announce a withdrawal
      // for it — the transport would go looking for a session that cannot exist.
      const link = recorder('10.4.2.9');
      registry.attach(link);

      assert.equal(await registry.remove('never-seen', testActor), false);
      assert.deepEqual(link.withdrawn, []);
    });

    it('closes a connected probe that its new filter no longer covers', async () => {
      // Narrowing a filter is a statement already true the moment it is written — the very next
      // handshake refuses this probe — so leaving the session up only decides *when*, and
      // "whenever it happens to reconnect" is an answer nobody chose. It would also make the
      // probes page lie: a filter of 10.0.0.0/24 beside a probe at 192.0.2.5, still scanning.
      const link = recorder('192.0.2.5');
      registry.attach(link);
      const first = await registry.admit(hello({ remoteAddress: '192.0.2.5' }));
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      await registry.setAllowFrom(first.gid, ['10.0.0.0/24'], testActor);
      assert.deepEqual(link.withdrawn, [
        {
          gid: first.gid,
          code: 'source-not-allowed',
          detail: 'this probe is not accepted from 192.0.2.5',
        },
      ]);
    });

    it('leaves one alone when the narrower filter still covers it', async () => {
      // The ordinary case, and the one that must cost nothing: an operator tightening a range
      // around the machines already inside it. Getting this wrong makes every filter edit an
      // outage.
      const link = recorder('10.0.0.9');
      registry.attach(link);
      const first = await registry.admit(hello({ remoteAddress: '10.0.0.9' }));
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      await registry.setAllowFrom(first.gid, ['10.0.0.0/24'], testActor);
      assert.deepEqual(link.withdrawn, [], 'a probe inside its own filter was disconnected');
    });

    it('falls back to the installation’s filter, exactly as the handshake does', async () => {
      // An empty per-probe list defers to `enrolFrom`, so clearing one does *not* mean anywhere
      // on an installation that has narrowed the default. The handshake resolves it that way;
      // this has to agree, or an operator would clear a filter and disconnect the probe — or,
      // worse, clear one and leave a probe connected from somewhere the installation refuses.
      const link = recorder('192.0.2.5');
      const narrowed = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        enrolmentKeys: ['shared-key'],
        enrolFrom: ['10.0.0.0/24'],
      });
      narrowed.attach(link);
      const first = await narrowed.admit(hello({ remoteAddress: '10.0.0.9' }));
      assert.ok(first.kind === 'pending');

      await narrowed.setAllowFrom(first.gid, ['192.0.2.0/24'], testActor);
      assert.deepEqual(link.withdrawn, [], 'its own filter covers where it is');

      await narrowed.setAllowFrom(first.gid, [], testActor);
      assert.deepEqual(
        link.withdrawn,
        [
          {
            gid: first.gid,
            code: 'source-not-allowed',
            detail: 'this probe is not accepted from 192.0.2.5',
          },
        ],
        'clearing it fell back to the installation filter, which does not cover this probe',
      );
    });

    it('says nothing about a filter change on a probe that is not connected', async () => {
      // The common case: an operator narrows a filter on a machine that is switched off. There
      // is nothing to close, and its next handshake is refused by `admit`.
      const link = recorder(null);
      registry.attach(link);
      const first = await registry.admit(hello({ remoteAddress: '192.0.2.5' }));
      assert.ok(first.kind === 'pending');

      await registry.setAllowFrom(first.gid, ['10.0.0.0/24'], testActor);
      assert.deepEqual(link.withdrawn, []);
    });
  });

  describe('where a probe may connect from', () => {
    it('refuses an approved probe from outside its filter', async () => {
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.4.0.0/16'], testActor);

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
        () => registry.setAllowFrom(first.gid, ['10.0.0.0/33'], testActor),
        (error: unknown) =>
          error instanceof Error && /prefix longer than 32 bits/.test(error.message),
      );
    });

    it('refuses an address the filter cannot express at all', async () => {
      // An IPv6 peer against a list of IPv4 ranges. The filter cannot say yes to something it
      // cannot describe, and refusing is the only answer that keeps it meaning what it says.
      const first = await registry.admit(hello());
      assert.ok(first.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.0.0.0/8'], testActor);

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
      await registry.approve(first.gid, probeId, testActor);
      // The key is issued at the next handshake, not at approval.
      const issued = await registry.admit(hello({ gid: first.gid }));
      assert.ok(issued.kind === 'approved' && issued.issuedKey !== undefined);
      const accessKey = issued.issuedKey;
      await registry.setAllowFrom(first.gid, ['10.9.0.0/24'], testActor);

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
      const after = await registry.setAllowFrom(first.gid, ['10.0.0.0/8'], testActor);
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
      await registry.approve(first.gid, probeId, testActor, { local: true });

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
      await registry.approve(first.gid, probeId, testActor);
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
      await registry.approve(first.gid, probeId, testActor, { local: true });
      await registry.revoke(first.gid, 'the machine was replaced', testActor);

      const second = await registry.admit(hello({ gid: 'the-replacement' }));
      assert.ok(second.kind === 'pending');
      await registry.approve(second.gid, probeId, testActor);

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
        hello({
          gid: first.gid,
          displayName: 'renamed-01',
          agentVersion: '0.2.0',
          remoteAddress: '10.4.9.9',
        }),
      );

      const stored = await registry.get(first.gid);
      assert.ok(stored !== null);
      assert.equal(stored.displayName, 'renamed-01');
      assert.equal(stored.agentVersion, '0.2.0');
      assert.equal(stored.lastAddress, '10.4.9.9');
      assert.notEqual(stored.lastSeenAt, null);
    });

    it('lists by status, so the queue is one query', async () => {
      const first = await registry.admit(hello());
      const second = await registry.admit(hello({ gid: 'second-machine' }));
      assert.ok(first.kind === 'pending' && second.kind === 'pending');
      await registry.approve(first.gid, probeId, testActor);

      assert.deepEqual(
        (await registry.list('pending')).map((one) => one.gid),
        [second.gid],
      );
      assert.equal((await registry.list()).length, 2);
    });
  });

  /**
   * Version skew (`R-06`).
   *
   * The refusal itself already existed, in the endpoint, before the registry saw the probe — so
   * the one refusal an operator is most likely to meet, having upgraded one end and not the
   * other, was the one refusal that left nothing behind to find. These are about the row.
   */
  describe('a probe below the protocol floor', () => {
    // **The floor is the only version refused now** (`P-178`). This block used to use 99 — a
    // version *newer* than this build — because a newer peer was refused too. Both ends negotiate
    // down instead: a newer probe is served what this core speaks, so the only version with no
    // shared language left is one below `MIN_PROTOCOL_VERSION`.
    it('is refused, and says which version each end speaks', async () => {
      const decision = await registry.admit(hello({ protocolVersion: 0 }));
      assert.equal(decision.kind, 'refused');
      assert.equal(decision.code, 'protocol-version');
      assert.match(decision.detail, /protocol 0/);
    });

    it('updates the recorded version before refusing, for a probe already known', async () => {
      // The point of moving the check here. An operator asking "why did backup-01 stop
      // scanning" needs the row to say 0, not the 6 it spoke the last time it managed to get
      // in — the stale number is the one that sends them looking in the wrong place.
      const first = await registry.admit(hello({ gid: 'known-machine', protocolVersion: 6 }));
      assert.equal(first.kind, 'pending');

      const decision = await registry.admit(hello({ gid: 'known-machine', protocolVersion: 0 }));
      assert.equal(decision.kind, 'refused');

      const stored = await registry.get('known-machine');
      assert.equal(stored?.protocolVersion, 0, 'the version it is actually running');
      // **And its skew reads `incompatible`, not `unknown`** (`U-35`). 0 is also the sentinel for
      // "has not connected since this core started recording versions", and until `U-35` a
      // probe that really claimed 0 read as one never seen. The refusal's time tells them apart
      // now: this one was refused, and says so.
      assert.equal(stored.skew.kind, 'incompatible');
      assert.match(stored.skew.explanation, /speaks protocol 0/);
      assert.match(stored.skew.explanation, /a hello was refused over it,/);
      assert.equal(typeof stored.protocolRefusedAt, 'string');
      assert.equal(stored.protocolAcceptedAt, null);
    });

    it('does not enrol one it has never seen, because approving it could not help', async () => {
      await registry.admit(hello({ gid: 'stranger', protocolVersion: 0 }));
      assert.equal(await registry.get('stranger'), null);
      assert.equal((await registry.list()).length, 0, 'nothing was added to the approval queue');
    });

    it('refuses it before the access key is even considered', async () => {
      // Otherwise the operator is told to check a key that was never the problem.
      const decision = await registry.admit(
        hello({ protocolVersion: 0, accessKey: 'not-the-shared-key' }),
      );
      assert.equal(decision.kind, 'refused');
      assert.equal(decision.code, 'protocol-version');
    });

    it('admits a probe newer than this build, which used to be refused', async () => {
      // **`P-178`.** Refusing a newer peer made every `PROTOCOL_VERSION` bump a lockstep fleet
      // upgrade: the un-upgraded end reconnected for ever while this core opened a session,
      // restored every sensor under it and sent a full push on each attempt. Every feature is
      // capability-gated on the negotiated version now, so the newer end cannot send this one a
      // field it would refuse — and the pair simply speaks what this build speaks.
      const decision = await registry.admit(hello({ gid: 'from-the-future', protocolVersion: 99 }));
      assert.notEqual(decision.kind, 'refused', 'it is admitted like any other probe');

      const stored = await registry.get('from-the-future');
      assert.equal(stored?.protocolVersion, 99, 'and the version it really speaks is recorded');
      assert.equal(stored.skew.kind, 'ahead', 'reported as a skew this end can fix, not a refusal');
    });

    /**
     * `GET /probes` names `ahead` (`P-313`). The registration schema's enum stopped at
     * `incompatible` when `P-178` added `ahead`, so the reference told a client a kind it would
     * be sent could not occur. The serializer does not check an enum, so the item is checked
     * against the route's own response schema, read off the route as Fastify registered it.
     */
    it('is served by GET /probes as ahead, which the route’s own schema allows (P-313)', async () => {
      let declared: unknown;
      // Validated as the server validates (`P-364`), not with Ajv's defaults.
      const app = Fastify({ ajv: { customOptions: { ...API_VALIDATOR_OPTIONS } } });
      app.addHook('onRoute', (route) => {
        if (route.url === '/probes' && route.method === 'GET') declared = route.schema?.response;
      });
      await app.register(probeRoutes, { registry });
      try {
        await registry.admit(
          hello({ gid: 'from-the-future', protocolVersion: PROTOCOL_VERSION + 1 }),
        );
        const response = await app.inject({ method: 'GET', url: '/probes' });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<{ items: Record<string, unknown>[] }>();
        const item = body.items.find((one) => one['gid'] === 'from-the-future');
        assert.ok(item !== undefined, response.body);
        assert.deepEqual(item['skew'], {
          kind: 'ahead',
          peerVersion: PROTOCOL_VERSION + 1,
          ownVersion: PROTOCOL_VERSION,
          explanation: (await registry.get('from-the-future'))?.skew.explanation,
        });

        const schema = (declared as Record<string, object> | undefined)?.['200'];
        assert.ok(schema !== undefined, 'the route declares its 200');
        const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
        assert.ok(validate(body), JSON.stringify(validate.errors));
      } finally {
        await app.close();
      }
    });
  });

  /**
   * When the recorded version was accepted (`U-32`).
   *
   * The add-sensor form says a probe that is down was too old "when it last connected", and says
   * when from `protocol_accepted_at`. `last_seen_at` cannot: every hello moves it before it is
   * decided. So the time is written with the version on an accepted handshake only, and a
   * refusal over the version clears it, so the pair is never a version beside another's time.
   */
  describe('when the recorded version was accepted', () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    let clocked: ProbeRegistry;
    const at = (iso: string): void => {
      clock = new Date(iso);
    };
    const recorded = async (
      gid: string,
    ): Promise<{
      version: number;
      acceptedAt: string | null;
      seenAt: string | null;
      refusedAt: string | null;
    }> => {
      const [row] = await db.query<{
        protocol_version: number;
        protocol_accepted_at: Date | null;
        last_seen_at: Date | null;
        protocol_refused_at: Date | null;
      }>(
        `SELECT protocol_version, protocol_accepted_at, last_seen_at, protocol_refused_at
         FROM probe_registration WHERE gid = $1`,
        [gid],
      );
      assert.ok(row !== undefined, `no row for ${gid}`);
      return {
        version: row.protocol_version,
        acceptedAt: row.protocol_accepted_at?.toISOString() ?? null,
        seenAt: row.last_seen_at?.toISOString() ?? null,
        refusedAt: row.protocol_refused_at?.toISOString() ?? null,
      };
    };

    beforeEach(() => {
      clocked = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: silentLogger,
        enrolmentKeys: ['shared-key'],
        now: () => clock,
      });
    });

    it('is written with the version by each accepted handshake, pending and approved', async () => {
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');
      assert.deepEqual(await recorded(first.gid), {
        version: PROTOCOL_VERSION - 9,
        acceptedAt: '2026-01-01T10:00:00.000Z',
        seenAt: '2026-01-01T10:00:00.000Z',
        refusedAt: null,
      });

      at('2026-01-02T10:00:00.000Z');
      const again = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION - 8 }),
      );
      assert.equal(again.kind, 'pending');
      const pending = await recorded(first.gid);
      assert.equal(pending.version, PROTOCOL_VERSION - 8);
      assert.equal(pending.acceptedAt, '2026-01-02T10:00:00.000Z');

      await clocked.approve(first.gid, probeId, testActor);
      at('2026-01-03T10:00:00.000Z');
      const approved = await clocked.admit(hello({ gid: first.gid }));
      assert.equal(approved.kind, 'approved');
      const now = await recorded(first.gid);
      assert.equal(now.version, PROTOCOL_VERSION);
      assert.equal(now.acceptedAt, '2026-01-03T10:00:00.000Z');
    });

    it('is left as it was by a refusal over anything but the version, and so is last seen (P-319)', async () => {
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');
      const kept = { version: PROTOCOL_VERSION - 9, acceptedAt: '2026-01-01T10:00:00.000Z' };
      const seen = (await recorded(first.gid)).seenAt;
      assert.notEqual(seen, null);
      const unchanged = async (why: string): Promise<void> => {
        const row = await recorded(first.gid);
        assert.deepEqual({ version: row.version, acceptedAt: row.acceptedAt }, kept, why);
        // Until `P-319` every hello moved it before it was decided, so a hello that proved
        // nothing said the probe had been seen.
        assert.equal(row.seenAt, seen, `${why}: and last seen did not move`);
      };

      at('2026-01-02T10:00:00.000Z');
      // A pending probe on the wrong enrolment key.
      const wrong = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION, accessKey: 'nope' }),
      );
      assert.equal(wrong.kind, 'refused');
      await unchanged('a pending probe with the wrong key');

      // An approved probe on a key that is not its own or the enrolment key.
      await clocked.approve(first.gid, probeId, testActor);
      const bad = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION, accessKey: 'nope' }),
      );
      assert.ok(bad.kind === 'refused' && bad.code === 'bad-access-key');
      await unchanged('an approved probe with the wrong key');

      // From an address its filter does not allow.
      await clocked.setAllowFrom(first.gid, ['192.0.2.0/24'], testActor);
      const elsewhere = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION }),
      );
      assert.ok(elsewhere.kind === 'refused' && elsewhere.code === 'source-not-allowed');
      await unchanged('an address the filter refuses');
      await clocked.setAllowFrom(first.gid, [], testActor);

      // Revoked.
      await clocked.revoke(first.gid, '', testActor);
      const revoked = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION }),
      );
      assert.ok(revoked.kind === 'refused' && revoked.code === 'revoked');
      await unchanged('a revoked identity');
    });

    it('is cleared by a refusal over the version, which records the version without a time', async () => {
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');

      at('2026-01-02T10:00:00.000Z');
      const refused = await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      assert.ok(refused.kind === 'refused' && refused.code === 'protocol-version');
      const row = await recorded(first.gid);
      assert.equal(row.version, 0, 'the version is recorded, as R-06 has it');
      assert.equal(row.acceptedAt, null, 'and no accepted handshake spoke it');
      assert.equal(row.refusedAt, '2026-01-02T10:00:00.000Z', 'and when it was refused (U-35)');

      // Refused again: the last refusal's time, which says it is still trying.
      at('2026-01-02T11:00:00.000Z');
      await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      assert.equal((await recorded(first.gid)).refusedAt, '2026-01-02T11:00:00.000Z');

      at('2026-01-03T10:00:00.000Z');
      await clocked.admit(hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION - 9 }));
      const accepted = await recorded(first.gid);
      assert.equal(accepted.acceptedAt, '2026-01-03T10:00:00.000Z');
      assert.equal(accepted.refusedAt, null, 'an accepted handshake clears the refusal');
    });

    it('leaves the refusal’s time as it was on a refusal over anything but the version (U-35)', async () => {
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');
      at('2026-01-02T10:00:00.000Z');
      await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));

      at('2026-01-03T10:00:00.000Z');
      const wrong = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION, accessKey: 'nope' }),
      );
      assert.ok(wrong.kind === 'refused' && wrong.code === 'bad-access-key');
      const row = await recorded(first.gid);
      assert.deepEqual(
        { version: row.version, acceptedAt: row.acceptedAt, refusedAt: row.refusedAt },
        { version: 0, acceptedAt: null, refusedAt: '2026-01-02T10:00:00.000Z' },
      );
    });

    it('reads a refusal from before migration 074 as nothing recorded, until the probe is refused again (P-316)', async () => {
      // **Not backfilled, and this is what that costs.** What the build before 074 left of a
      // refusal at 0 is the 0 and no accepted time, which is also the `R-01` upgrade's row for a
      // probe not accepted since; `last_seen_at` was moved before the key was checked until
      // `P-319`, so it dates any hello at all. Migration 074 leaves the refusal's time NULL, and
      // the row reads `unknown` until the next refused hello writes one. A refused probe keeps
      // retrying, so a running one is told apart at its next hello.
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');
      at('2026-01-02T10:00:00.000Z');
      await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      await db.query('UPDATE probe_registration SET protocol_refused_at = NULL WHERE gid = $1', [
        first.gid,
      ]);
      const carried = await clocked.get(first.gid);
      assert.ok(carried !== null);
      assert.equal(carried.protocolVersion, 0);
      assert.equal(carried.protocolAcceptedAt, null);
      assert.equal(carried.protocolRefusedAt, null);
      assert.equal(carried.skew.kind, 'unknown', 'what the upgrade note says it reads as');

      at('2026-01-09T10:00:00.000Z');
      const again = await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      assert.ok(again.kind === 'refused' && again.code === 'protocol-version');
      const told = await clocked.get(first.gid);
      assert.ok(told !== null);
      assert.equal(told.protocolRefusedAt, '2026-01-09T10:00:00.000Z');
      assert.equal(told.skew.kind, 'incompatible');
      assert.match(told.skew.explanation, /a hello was refused over it,/);
    });

    it('never calls a version refusal the last hello once a later one failed its proof (P-317 review)', async () => {
      // The refusal's time moves only on a version refusal, and since `P-319` a hello that does
      // not prove it is this probe writes nothing. So a probe upgraded since, now refused for its
      // key, still has the old version refusal recorded, and "its last hello was refused over its
      // version" would send the operator after a version while its journal says the key.
      at('2026-01-01T10:00:00.000Z');
      const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
      assert.ok(first.kind === 'pending');
      at('2026-01-02T10:00:00.000Z');
      const refused = await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      assert.ok(refused.kind === 'refused' && refused.code === 'protocol-version');
      await clocked.approve(first.gid, probeId, testActor);

      // Upgraded, and presenting a key that is not its own: refused before it proved anything.
      at('2026-01-03T10:00:00.000Z');
      const unproven = await clocked.admit(
        hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION, accessKey: 'nope' }),
      );
      assert.ok(unproven.kind === 'refused' && unproven.code === 'bad-access-key');

      const row = await clocked.get(first.gid);
      assert.ok(row !== null);
      assert.equal(row.protocolRefusedAt, '2026-01-02T10:00:00.000Z', 'the version refusal stays');
      assert.match(row.skew.explanation, /a hello was refused over it,/);
      assert.doesNotMatch(row.skew.explanation, /last hello/);

      // And the health answer's message, from the same row, as the route builds it.
      const health = new ProbeHealthService({
        vouching: everyVoucherHolds,
        db,
        logger: silentLogger,
        sources: { link: () => ({ connected: false }) },
        ingest: () => Promise.resolve(),
      });
      const last = await health.lastProtocol(probeId);
      assert.deepEqual(last, { version: 0, at: null, refusedAt: '2026-01-02T10:00:00.000Z' });
      const message = withLastRefusal(health.read(probeId).message, last);
      assert.equal(
        message,
        'not connected to the core; the last hello refused over its version, at ' +
          `2026-01-02T10:00:00.000Z, spoke protocol 0; this core accepts protocol ` +
          `${String(MIN_PROTOCOL_VERSION)} or newer`,
      );
      assert.doesNotMatch(message, /its last hello/i);
      assert.ok(!message.includes('2026-01-03'), 'the unproven hello is not dated as a refusal');
    });

    /**
     * `GET /probes` carries the time beside the version (`U-33`). It showed `protocolVersion`
     * beside `lastSeenAt` only, and every hello moves that, so a probe refused at one time read as
     * having spoken its version then. Through the route's own schema, which drops a field it does
     * not declare, so the registration having the field is not enough.
     */
    it('is served by GET /probes as protocolAcceptedAt, apart from lastSeenAt (U-33)', async () => {
      // Validated as the server validates (`P-364`), not with Ajv's defaults.
      const app = Fastify({ ajv: { customOptions: { ...API_VALIDATOR_OPTIONS } } });
      await app.register(probeRoutes, { registry: clocked });
      const listed = async (gid: string): Promise<Record<string, unknown>> => {
        const response = await app.inject({ method: 'GET', url: '/probes' });
        assert.equal(response.statusCode, 200, response.body);
        const item = response
          .json<{ items: Record<string, unknown>[] }>()
          .items.find((one) => one['gid'] === gid);
        assert.ok(item !== undefined, `${gid} not listed: ${response.body}`);
        const registration = await clocked.get(gid);
        assert.equal(item['protocolAcceptedAt'], registration?.protocolAcceptedAt);
        assert.equal(item['protocolRefusedAt'], registration?.protocolRefusedAt);
        return item;
      };
      try {
        at('2026-01-01T10:00:00.000Z');
        const first = await clocked.admit(hello({ protocolVersion: PROTOCOL_VERSION - 9 }));
        assert.ok(first.kind === 'pending');
        const enrolled = await listed(first.gid);
        assert.equal(enrolled['protocolVersion'], PROTOCOL_VERSION - 9);
        assert.equal(enrolled['protocolAcceptedAt'], '2026-01-01T10:00:00.000Z');

        // Refused over the version: the version it declared, no time, and last seen moved.
        at('2026-01-02T10:00:00.000Z');
        await clocked.admit(hello({ gid: first.gid, protocolVersion: 0 }));
        const refused = await listed(first.gid);
        assert.equal(refused['protocolVersion'], 0);
        assert.ok('protocolAcceptedAt' in refused, JSON.stringify(refused));
        assert.equal(refused['protocolAcceptedAt'], null);
        assert.equal(typeof refused['lastSeenAt'], 'string');
        // And when it was refused, so the 0 is not the upgrade's "nothing recorded" (`U-35`).
        assert.equal(refused['protocolRefusedAt'], '2026-01-02T10:00:00.000Z');
        const refusedSkew = refused['skew'] as Record<string, unknown>;
        assert.equal(refusedSkew['kind'], 'incompatible');
        assert.match(String(refusedSkew['explanation']), /a hello was refused over it,/);
        assert.equal(enrolled['protocolRefusedAt'], null);

        // Accepted again, then refused for its key: the accepted time stays, and since `P-319`
        // last seen does too, because that hello proved nothing.
        at('2026-01-03T10:00:00.000Z');
        await clocked.admit(hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION - 8 }));
        const accepted = await listed(first.gid);
        assert.equal(accepted['protocolAcceptedAt'], '2026-01-03T10:00:00.000Z');
        assert.ok('protocolRefusedAt' in accepted, JSON.stringify(accepted));
        assert.equal(accepted['protocolRefusedAt'], null);
        await db.query(
          "UPDATE probe_registration SET last_seen_at = '2026-01-03T10:00:00Z' WHERE gid = $1",
          [first.gid],
        );
        at('2026-01-04T10:00:00.000Z');
        await clocked.admit(
          hello({ gid: first.gid, protocolVersion: PROTOCOL_VERSION, accessKey: 'nope' }),
        );
        const keyRefused = await listed(first.gid);
        assert.equal(keyRefused['protocolVersion'], PROTOCOL_VERSION - 8);
        assert.equal(keyRefused['protocolAcceptedAt'], '2026-01-03T10:00:00.000Z');
        assert.equal(keyRefused['lastSeenAt'], '2026-01-03T10:00:00.000Z');
      } finally {
        await app.close();
      }
    });
  });

  /**
   * A hello that has not proved the identity it names (`P-319`).
   *
   * mTLS proves only that the peer holds a certificate the installation's CA signed; nothing ties
   * that certificate to a GID. So the access key, the revocation and the address filter are what
   * prove a hello is the probe it names, and until they have, nothing is written to that probe's
   * row. `admit` used to write the name, agent version, address and last seen first, and on a
   * version refusal the version and the refusal's time, so a forged hello could rename an
   * approved, connected probe and have `/probes` call it refused (`U-35`).
   */
  describe('a hello that has not proved the identity it names (P-319)', () => {
    const lines: Record<string, unknown>[] = [];
    let clock = new Date('2026-01-01T10:00:00.000Z');
    let proving: ProbeRegistry;
    const recorder: { closed: string[]; withdrawn: string[] } = { closed: [], withdrawn: [] };

    beforeEach(() => {
      lines.length = 0;
      recorder.closed.length = 0;
      recorder.withdrawn.length = 0;
      clock = new Date('2026-01-01T10:00:00.000Z');
      proving = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        // The service's own logger, so a line carries the correlation context it was said in.
        logger: createLogger({
          name: 'ms-core',
          level: 'warn',
          destination: {
            write: (chunk: string) => {
              lines.push(JSON.parse(chunk) as Record<string, unknown>);
            },
          },
        }),
        enrolmentKeys: ['shared-key'],
        now: () => clock,
      });
      proving.attach({
        disconnect: (gid) => {
          recorder.closed.push(gid);
          return true;
        },
        withdraw: (gid) => {
          recorder.withdrawn.push(gid);
          return true;
        },
        remoteAddressOf: () => '10.4.2.9',
      });
    });

    /**
     * What every refusal of a hello that proved nothing says (`P-319` review): why it was
     * refused, what the hello claimed, and why its identity was not proven.
     */
    const unprovenShape = (
      line: Record<string, unknown>,
      code: string,
      protocolVersion: number,
      claimed = { displayName: 'not-backup-01', agentVersion: '6.6.6' },
    ): void => {
      const shown = JSON.stringify(line);
      assert.equal(line['code'], code, shown);
      assert.deepEqual(line['claimed'], { ...claimed, protocolVersion }, shown);
      assert.equal(typeof line['unprovenBecause'], 'string', shown);
      assert.notEqual(line['unprovenBecause'], '', shown);
      assert.equal(typeof line['msg'], 'string', shown);
      if (code === 'protocol-version') {
        assert.equal(line['coreProtocolVersion'], PROTOCOL_VERSION, shown);
      }
    };

    /** Every column of the row, as text, so "unchanged" means every one of them. */
    const row = async (gid: string): Promise<Record<string, unknown>> => {
      const [found] = await db.query<Record<string, unknown>>(
        `SELECT * FROM probe_registration WHERE gid = $1`,
        [gid],
      );
      assert.ok(found !== undefined, `no row for ${gid}`);
      return JSON.parse(JSON.stringify(found)) as Record<string, unknown>;
    };

    /**
     * An approved probe that is connected and working: enrolled, approved, issued its own key,
     * and in on that key — so the enrolment key no longer proves it is this probe.
     */
    const approvedAndConnected = async (): Promise<{ gid: string; key: string }> => {
      const first = await proving.admit(hello({ displayName: 'backup-01', agentVersion: '0.1.0' }));
      assert.ok(first.kind === 'pending');
      await proving.approve(first.gid, probeId, testActor);
      const issuing = await proving.admit(hello({ gid: first.gid }));
      assert.ok(issuing.kind === 'approved' && issuing.issuedKey !== undefined);
      const own = await proving.admit(hello({ gid: first.gid, accessKey: issuing.issuedKey }));
      assert.equal(own.kind, 'approved');
      const stored = await proving.get(first.gid);
      assert.ok(stored?.hasOwnKey === true && stored.protocolAcceptedAt !== null);
      recorder.closed.length = 0;
      return { gid: first.gid, key: issuing.issuedKey };
    };

    const forgeries: readonly {
      name: string;
      /** What else is true of the probe first: revoked, or narrowed to an address. */
      arrange?: (gid: string) => Promise<unknown>;
      over: (probe: { gid: string; key: string }) => Partial<Parameters<ProbeRegistry['admit']>[0]>;
      code: string;
    }[] = [
      {
        name: 'a version this core refuses, with a key that is nobody’s',
        over: ({ gid }) => ({ gid, protocolVersion: 0, accessKey: 'forged' }),
        code: 'protocol-version',
      },
      {
        name: 'a version this core refuses, with the enrolment key the probe no longer uses',
        over: ({ gid }) => ({ gid, protocolVersion: 0, accessKey: 'shared-key' }),
        code: 'protocol-version',
      },
      {
        name: 'a version this core speaks, with a key that is nobody’s',
        over: ({ gid }) => ({ gid, accessKey: 'forged' }),
        code: 'bad-access-key',
      },
      {
        name: 'a version this core speaks, with the enrolment key the probe no longer uses',
        over: ({ gid }) => ({ gid, accessKey: 'shared-key' }),
        code: 'bad-access-key',
      },
      {
        name: 'a revoked identity',
        arrange: (gid) => proving.revoke(gid, 'replaced by web-dc4', testActor),
        over: ({ gid, key }) => ({ gid, accessKey: key }),
        code: 'revoked',
      },
      {
        name: 'a revoked identity, at a version this core refuses',
        arrange: (gid) => proving.revoke(gid, '', testActor),
        over: ({ gid, key }) => ({ gid, accessKey: key, protocolVersion: 0 }),
        code: 'protocol-version',
      },
      {
        name: 'the probe’s own key, from an address its filter does not allow',
        arrange: (gid) => proving.setAllowFrom(gid, ['10.4.2.0/24'], testActor),
        over: ({ gid, key }) => ({ gid, accessKey: key }),
        code: 'source-not-allowed',
      },
      {
        name: 'the probe’s own key, from an address its filter does not allow, at a version this core refuses',
        arrange: (gid) => proving.setAllowFrom(gid, ['10.4.2.0/24'], testActor),
        over: ({ gid, key }) => ({ gid, accessKey: key, protocolVersion: 0 }),
        code: 'protocol-version',
      },
    ];

    for (const forgery of forgeries) {
      it(`leaves an approved, connected probe’s row as it was: ${forgery.name}`, async () => {
        const probe = await approvedAndConnected();
        await forgery.arrange?.(probe.gid);
        const before = await row(probe.gid);
        const counted = proving.stats().hellosRefusedUnproven;
        recorder.withdrawn.length = 0;

        clock = new Date('2026-01-05T04:12:00.000Z');
        const decision = await withCorrelation({ requestId: 'forged-hello' }, () =>
          proving.admit(
            hello({
              displayName: 'not-backup-01',
              agentVersion: '6.6.6',
              remoteAddress: '192.0.2.66',
              ...forgery.over(probe),
            }),
          ),
        );
        assert.ok(decision.kind === 'refused', JSON.stringify(decision));
        assert.equal(decision.code, forgery.code);

        // Name, agent version, address, last seen, protocol version, and the accepted and
        // refused times: every column.
        assert.deepEqual(await row(probe.gid), before);
        const after = await proving.get(probe.gid);
        assert.equal(after?.displayName, 'backup-01');
        assert.equal(after.skew.kind, 'current', 'not called incompatible (U-35)');
        assert.equal(after.protocolRefusedAt, null, 'nor refused over its version');

        // Observable all the same: counted once, and said under the handshake's correlation id,
        // with what the hello claimed.
        assert.equal(proving.stats().hellosRefusedUnproven, counted + 1);
        const said = lines.filter((line) => line['requestId'] === 'forged-hello');
        assert.equal(said.length, 1, JSON.stringify(lines));
        const [line] = said;
        assert.ok(line !== undefined);
        assert.equal(line['gid'], probe.gid);
        assert.equal(line['remoteAddress'], '192.0.2.66');
        assert.equal(line['level'], 'warn');
        // The shape `administration.md` promises, whatever it was refused for: the line is the
        // only record of what the hello claimed.
        unprovenShape(line, forgery.code, forgery.over(probe).protocolVersion ?? PROTOCOL_VERSION);
        // And nothing was done to the live connection.
        assert.deepEqual(recorder, { closed: [], withdrawn: [] });
      });
    }

    it('still records a refusal over the version for a probe that proved it is this one (U-35)', async () => {
      const probe = await approvedAndConnected();
      clock = new Date('2026-01-05T04:12:00.000Z');
      const decision = await proving.admit(
        hello({ gid: probe.gid, accessKey: probe.key, protocolVersion: 0, agentVersion: '0.0.9' }),
      );
      assert.ok(decision.kind === 'refused' && decision.code === 'protocol-version');
      const after = await proving.get(probe.gid);
      assert.equal(after?.protocolVersion, 0);
      assert.equal(after.protocolRefusedAt, '2026-01-05T04:12:00.000Z');
      assert.equal(after.protocolAcceptedAt, null);
      assert.equal(after.agentVersion, '0.0.9', 'and what it says about itself');
      assert.equal(after.skew.kind, 'incompatible');
      assert.equal(proving.stats().hellosRefusedUnproven, 0, 'proven, so not counted');
    });

    it('records it for a probe that proved itself on the enrolment key its own never replaced', async () => {
      // `P-37`'s window: approved, issued a key in a welcome that never arrived. The enrolment
      // key is still what proves it, so its refusal is recorded — and it is not issued a key in
      // a welcome it will not be sent.
      const first = await proving.admit(hello());
      assert.ok(first.kind === 'pending');
      await proving.approve(first.gid, probeId, testActor);
      clock = new Date('2026-01-05T04:12:00.000Z');
      const decision = await proving.admit(hello({ gid: first.gid, protocolVersion: 0 }));
      assert.ok(decision.kind === 'refused' && decision.code === 'protocol-version');
      const after = await row(first.gid);
      assert.equal(after['protocol_refused_at'], '2026-01-05T04:12:00.000Z');
      assert.equal(after['access_key_hash'], null, 'no key issued to a refused hello');
    });

    it('counts a new GID refused for its key, its address or its version, and enrols none', async () => {
      const narrowed = new ProbeRegistry({
        db,
        audit: new DatabaseAuditSink(),
        logger: createLogger({
          name: 'ms-core',
          level: 'warn',
          destination: {
            write: (chunk: string) => {
              lines.push(JSON.parse(chunk) as Record<string, unknown>);
            },
          },
        }),
        enrolmentKeys: ['shared-key'],
        enrolFrom: ['10.0.0.0/8'],
      });
      for (const [over, code] of [
        [{ gid: 'stranger-key', accessKey: 'forged' }, 'bad-access-key'],
        [{ gid: 'stranger-address', remoteAddress: '192.0.2.66' }, 'source-not-allowed'],
        [{ gid: 'stranger-version', protocolVersion: 0 }, 'protocol-version'],
      ] as const) {
        const decision = await withCorrelation({ requestId: over.gid }, () =>
          narrowed.admit(hello(over)),
        );
        assert.ok(decision.kind === 'refused' && decision.code === code, over.gid);
        // Said once, in the shape every unproven refusal has.
        const said = lines.filter((line) => line['requestId'] === over.gid);
        assert.equal(said.length, 1, JSON.stringify(lines));
        const [line] = said;
        assert.ok(line !== undefined);
        unprovenShape(
          line,
          code,
          'protocolVersion' in over ? over.protocolVersion : PROTOCOL_VERSION,
          {
            displayName: 'backup-01',
            agentVersion: '0.1.0',
          },
        );
      }
      assert.equal(narrowed.stats().hellosRefusedUnproven, 3);
      assert.equal((await narrowed.list()).length, 0);
      // A genuine enrolment is not counted, and still enrols (`R-01`).
      assert.equal((await narrowed.admit(hello({ gid: 'newcomer' }))).kind, 'pending');
      assert.equal(narrowed.stats().hellosRefusedUnproven, 3);
    });
  });

  describe('the skew reported against a registration', () => {
    it('is current for a probe speaking this build’s own version', async () => {
      const decision = await registry.admit(hello({ gid: 'current-machine' }));
      assert.equal(decision.kind, 'pending');
      assert.equal((await registry.get('current-machine'))?.skew.kind, 'current');
    });

    it('is outdated — not incompatible — for one that connects but can do nothing', async () => {
      // The whole reason `R-06` exists: this probe is healthy by every other measure.
      await registry.admit(hello({ gid: 'old-machine', protocolVersion: 2 }));
      const stored = await registry.get('old-machine');
      assert.equal(stored?.skew.kind, 'outdated');
      assert.match(stored.skew.explanation, /cannot be sent sensors to scan/);
    });

    it('is unknown for a row an upgrade carried over, not a red mark', async () => {
      // `R-01`'s migration approved the probes that already existed and had no version to record
      // for them. Reading that zero as "speaks protocol 0" would condemn every one of them
      // before any had reconnected.
      await db.query(
        `INSERT INTO probe_registration (gid, status, object_id, decided_at)
         VALUES ('carried-over', 'approved', $1, now())`,
        [probeId],
      );
      const stored = await registry.get('carried-over');
      assert.equal(stored?.protocolVersion, 0);
      assert.equal(stored.skew.kind, 'unknown');
      assert.match(stored.skew.explanation, /has not connected/);
      assert.equal(stored.protocolRefusedAt, null);
    });

    it('says a version this core refuses, with no refusal recorded, will be refused at the next hello (U-35)', async () => {
      // What a core with a lower floor leaves behind once this one's floor is above it: a version
      // it accepted, which this core refuses, and no refusal yet. The floor is 1 and a hello's
      // version is at least 0, so no such row can be written by a handshake today; -1, which the
      // column allows, stands in for it, because the skew reads it the same way.
      await db.query(
        `INSERT INTO probe_registration (gid, status, object_id, decided_at, protocol_version)
         VALUES ('accepted-then', 'approved', $1, now(), -1)`,
        [probeId],
      );
      const stored = await registry.get('accepted-then');
      assert.equal(stored?.skew.kind, 'incompatible');
      assert.match(stored.skew.explanation, /will be refused when it next connects/);
      assert.doesNotMatch(stored.skew.explanation, /hello was refused/);
    });
  });
});
