import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  credentialFingerprint,
  SnmpSessionPool,
  stringOf,
  withSnmp,
  type SnmpCredentials,
} from '../src/support/snmp/index.js';
import { TestSnmpAgent, type AgentEntry } from './support/snmp-agent.js';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const MIB: AgentEntry[] = [{ oid: SYS_DESCR, type: 'OctetString', value: 'ms-target router' }];

const PUBLIC: SnmpCredentials = { version: 'v2c', community: 'public' };
const PRIVATE: SnmpCredentials = { version: 'v2c', community: 'private' };

let agent: TestSnmpAgent;
let pool: SnmpSessionPool;

before(async () => {
  agent = await TestSnmpAgent.start(MIB);
});

after(async () => {
  await agent.stop();
});

beforeEach(() => {
  agent.behave({});
  agent.accept('public', 'private');
  pool = new SnmpSessionPool({ idleMs: 50, maxSessions: 3 });
});

function target(): { host: string; port: number } {
  return { host: agent.host, port: agent.port };
}

const OPTIONS = { timeoutMs: 400, retries: 0 };

describe('sharing a session', () => {
  it('hands the same session to two sensors on one device', () => {
    // The reason the pool exists: forty sensors on a router is forty sockets otherwise.
    const first = pool.acquire(target(), PUBLIC, OPTIONS);
    const second = pool.acquire(target(), PUBLIC, OPTIONS);
    try {
      assert.equal(first.session, second.session);
      assert.equal(pool.stats().sessions, 1);
      assert.equal(pool.stats().reused, 1);
      assert.equal(pool.stats().opened, 1);
    } finally {
      first.release();
      second.release();
      pool.closeAll();
    }
  });

  it('does not share between different credentials', () => {
    // A rotated community must not keep authenticating as the old one.
    const first = pool.acquire(target(), PUBLIC, OPTIONS);
    const second = pool.acquire(target(), PRIVATE, OPTIONS);
    try {
      assert.notEqual(first.session, second.session);
      assert.equal(pool.stats().sessions, 2);
    } finally {
      first.release();
      second.release();
      pool.closeAll();
    }
  });

  it('does not share between different deadlines', () => {
    // Timeout and retries are baked in at open time, so a sensor with a stricter deadline must
    // not silently impose it on one with a longer one.
    const first = pool.acquire(target(), PUBLIC, { timeoutMs: 400, retries: 0 });
    const second = pool.acquire(target(), PUBLIC, { timeoutMs: 900, retries: 0 });
    try {
      assert.notEqual(first.session, second.session);
    } finally {
      first.release();
      second.release();
      pool.closeAll();
    }
  });

  it('does not share between ports', () => {
    const first = pool.acquire({ host: agent.host, port: agent.port }, PUBLIC, OPTIONS);
    const second = pool.acquire({ host: agent.host, port: agent.port + 1 }, PUBLIC, OPTIONS);
    try {
      assert.notEqual(first.session, second.session);
    } finally {
      first.release();
      second.release();
      pool.closeAll();
    }
  });

  it('really does talk over the one shared socket', async () => {
    const first = pool.acquire(target(), PUBLIC, OPTIONS);
    const second = pool.acquire(target(), PUBLIC, OPTIONS);
    try {
      const controller = new AbortController();
      const [a, b] = await Promise.all([
        first.session.get([SYS_DESCR], controller.signal),
        second.session.get([SYS_DESCR], controller.signal),
      ]);
      assert.equal(stringOf(a[0] ?? { oid: '', type: 'Null', value: null }), 'ms-target router');
      assert.equal(stringOf(b[0] ?? { oid: '', type: 'Null', value: null }), 'ms-target router');
    } finally {
      first.release();
      second.release();
      pool.closeAll();
    }
  });
});

describe('the fingerprint the pool keys on', () => {
  it('does not contain the secret', () => {
    // A plain key would put a community string in a Map that any error message or heap dump
    // could reach. CLAUDE.md: a monitored device's credentials do not leave where they are used.
    const fingerprint = credentialFingerprint(PUBLIC);
    assert.equal(fingerprint.includes('public'), false);
    assert.match(fingerprint, /^[0-9a-f]{16}$/);
  });

  it('is the same for the same credentials and different for different ones', () => {
    assert.equal(credentialFingerprint(PUBLIC), credentialFingerprint({ ...PUBLIC }));
    assert.notEqual(credentialFingerprint(PUBLIC), credentialFingerprint(PRIVATE));
  });

  it('changes when any part of a v3 identity changes', () => {
    const base: SnmpCredentials = {
      version: 'v3',
      username: 'ops',
      level: 'authPriv',
      authProtocol: 'sha',
      authKey: 'auth-secret',
      privProtocol: 'aes',
      privKey: 'priv-secret',
    };
    const seen = new Set([
      credentialFingerprint(base),
      credentialFingerprint({ ...base, username: 'other' }),
      credentialFingerprint({ ...base, authKey: 'rotated' }),
      credentialFingerprint({ ...base, privKey: 'rotated' }),
      credentialFingerprint({ ...base, level: 'authNoPriv' }),
      credentialFingerprint({ ...base, context: 'vrf-a' }),
    ]);
    assert.equal(seen.size, 6);
  });
});

describe('releasing', () => {
  it('keeps the session open for the next sensor', () => {
    const lease = pool.acquire(target(), PUBLIC, OPTIONS);
    lease.release();
    assert.equal(pool.stats().sessions, 1);
    assert.equal(pool.stats().inUse, 0);

    const next = pool.acquire(target(), PUBLIC, OPTIONS);
    try {
      assert.equal(pool.stats().reused, 1);
    } finally {
      next.release();
      pool.closeAll();
    }
  });

  it('counts a double release once', () => {
    // A retry wrapper or a second catch running `finally` twice would otherwise take the count
    // below zero and make a session that is in use look idle and evictable.
    const first = pool.acquire(target(), PUBLIC, OPTIONS);
    const second = pool.acquire(target(), PUBLIC, OPTIONS);
    try {
      first.release();
      first.release();
      first.release();
      assert.equal(pool.stats().inUse, 1, 'the second lease still holds it');
    } finally {
      second.release();
      pool.closeAll();
    }
  });
});

describe('eviction', () => {
  // A long idle window and an explicit clock, so these test eviction rather than race the
  // pool's own sweeper — which fires on the same interval and would otherwise get there first.
  const patient = (): SnmpSessionPool => new SnmpSessionPool({ idleMs: 60_000, maxSessions: 3 });
  const later = (): number => Date.now() + 120_000;

  it('closes a session nobody has used for a while', () => {
    const held = patient();
    const lease = held.acquire(target(), PUBLIC, OPTIONS);
    const session = lease.session;
    lease.release();

    assert.equal(held.sweep(later()), 1);
    assert.equal(held.stats().sessions, 0);
    assert.equal(held.stats().evicted, 1);
    // A pool that forgot the entry but left the socket open would be a leak that no longer
    // shows in the stats — the worst shape for this bug to take.
    assert.equal(session.closed, true);
  });

  it('never closes one that is in use', () => {
    const held = patient();
    const lease = held.acquire(target(), PUBLIC, OPTIONS);
    try {
      assert.equal(held.sweep(later()), 0);
      assert.equal(lease.session.closed, false);
    } finally {
      lease.release();
      held.closeAll();
    }
  });

  it('opens a fresh session after the old one was evicted', () => {
    const held = patient();
    const first = held.acquire(target(), PUBLIC, OPTIONS);
    first.release();
    held.sweep(later());

    const second = held.acquire(target(), PUBLIC, OPTIONS);
    try {
      assert.notEqual(second.session, first.session);
      assert.equal(second.session.closed, false);
      assert.equal(held.stats().opened, 2);
    } finally {
      second.release();
      held.closeAll();
    }
  });

  it('sweeps on its own, without anybody calling it', async () => {
    // The timer is what makes eviction happen on an idle probe at 3am. It is `unref`'d, so it
    // must fire without holding the process open.
    const lease = pool.acquire(target(), PUBLIC, OPTIONS);
    const session = lease.session;
    lease.release();

    const deadline = Date.now() + 2_000;
    while (!session.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(session.closed, true, 'the sweeper should have closed an idle session');
    assert.ok(pool.stats().evicted >= 1);
  });

  it('replaces a session that was closed from underneath it', () => {
    const first = pool.acquire(target(), PUBLIC, OPTIONS);
    first.release();
    first.session.close();

    const second = pool.acquire(target(), PUBLIC, OPTIONS);
    try {
      // Handing back a session whose every request would fail is worse than opening another.
      assert.notEqual(second.session, first.session);
      assert.equal(second.session.closed, false);
    } finally {
      second.release();
      pool.closeAll();
    }
  });
});

describe('the bound', () => {
  it('closes the oldest idle session to make room', () => {
    const leases = [1, 2, 3].map((offset) =>
      pool.acquire({ host: agent.host, port: agent.port + offset }, PUBLIC, OPTIONS),
    );
    for (const lease of leases) lease.release();
    assert.equal(pool.stats().sessions, 3);

    const fourth = pool.acquire({ host: agent.host, port: agent.port + 4 }, PUBLIC, OPTIONS);
    try {
      assert.equal(pool.stats().sessions, 3, 'still at the bound');
      assert.equal(pool.stats().overflowed, 0);
      assert.equal(leases[0]?.session.closed, true, 'the least recently used one went');
    } finally {
      fourth.release();
      pool.closeAll();
    }
  });

  it('opens past the bound rather than failing a check, and counts it', () => {
    // Refusing would fail a check that would have worked, to protect a file-descriptor budget.
    // Opening anyway is the right trade — and CLAUDE.md requires it be counted, not silent.
    const leases = [1, 2, 3].map((offset) =>
      pool.acquire({ host: agent.host, port: agent.port + offset }, PUBLIC, OPTIONS),
    );
    const extra = pool.acquire({ host: agent.host, port: agent.port + 9 }, PUBLIC, OPTIONS);
    try {
      assert.equal(pool.stats().sessions, 4, 'over the bound, deliberately');
      assert.equal(pool.stats().overflowed, 1);
    } finally {
      for (const lease of leases) lease.release();
      extra.release();
      pool.closeAll();
    }
  });
});

describe('withSnmp', () => {
  it('releases the lease when the body succeeds', async () => {
    const value = await withSnmp(
      target(),
      PUBLIC,
      OPTIONS,
      async (session) =>
        stringOf(
          (await session.get([SYS_DESCR], new AbortController().signal))[0] ?? {
            oid: '',
            type: 'Null',
            value: null,
          },
        ),
      pool,
    );
    assert.equal(value, 'ms-target router');
    assert.equal(pool.stats().inUse, 0);
    pool.closeAll();
  });

  it('releases the lease when the body throws', async () => {
    // The one that matters. A check that threw while holding a lease would leave the session
    // counted as busy for ever: never evicted, and filling the bound with nothing.
    await assert.rejects(
      () =>
        withSnmp(
          target(),
          PUBLIC,
          OPTIONS,
          () => {
            throw new Error('the check failed');
          },
          pool,
        ),
      /the check failed/,
    );
    assert.equal(pool.stats().inUse, 0);
    pool.closeAll();
  });

  it('releases the lease when the check is aborted', async () => {
    agent.behave({ silent: true });
    const controller = new AbortController();
    const pending = withSnmp(
      target(),
      PUBLIC,
      { timeoutMs: 10_000, retries: 0 },
      (session) => session.get([SYS_DESCR], controller.signal),
      pool,
    );
    controller.abort();
    await assert.rejects(() => pending, /cancelled/);
    assert.equal(pool.stats().inUse, 0);
    pool.closeAll();
  });
});

describe('closeAll', () => {
  it('closes sessions that are still leased, for worker shutdown', () => {
    const lease = pool.acquire(target(), PUBLIC, OPTIONS);
    pool.closeAll();
    assert.equal(lease.session.closed, true);
    assert.equal(pool.stats().sessions, 0);
  });
});
