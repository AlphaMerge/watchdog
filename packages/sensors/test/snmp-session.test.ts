import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  isException,
  numberOf,
  SnmpError,
  SnmpSession,
  stringOf,
  worstCaseMs,
  type SnmpCredentials,
} from '../src/support/snmp/index.js';
import { TestSnmpAgent, type AgentEntry } from '@ms/simulators';

const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const IF_DESCR = '1.3.6.1.2.1.2.2.1.2';
const IF_HC_IN = '1.3.6.1.2.1.31.1.1.1.6';

const MIB: AgentEntry[] = [
  { oid: SYS_DESCR, type: 'OctetString', value: 'ms-target router' },
  { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 123_456 },
  { oid: `${IF_DESCR}.1`, type: 'OctetString', value: 'lo' },
  { oid: `${IF_DESCR}.2`, type: 'OctetString', value: 'eth0' },
  { oid: `${IF_DESCR}.3`, type: 'OctetString', value: 'eth1' },
  { oid: '1.3.6.1.2.1.2.2.1.8.1', type: 'Integer', value: 1 },
  { oid: '1.3.6.1.2.1.2.2.1.8.2', type: 'Integer', value: 2 },
  // Past 2^53, which is the whole reason Counter64 must not become a `number`.
  { oid: `${IF_HC_IN}.2`, type: 'Counter64', value: 18_446_744_073_709_551_000n },
  { oid: '1.3.6.1.2.1.25.1.1.0', type: 'Counter', value: 42 },
];

const V2C: SnmpCredentials = { version: 'v2c', community: 'public' };

let agent: TestSnmpAgent;

before(async () => {
  agent = await TestSnmpAgent.start(MIB);
});

after(async () => {
  await agent.stop();
});

beforeEach(() => {
  agent.behave({});
  agent.accept('public');
  agent.load(MIB);
});

function open(overrides: Parameters<typeof SnmpSession.open>[2] = {}): SnmpSession {
  return SnmpSession.open({ host: agent.host, port: agent.port }, V2C, {
    timeoutMs: 400,
    retries: 0,
    ...overrides,
  });
}

function live(): AbortSignal {
  return new AbortController().signal;
}

describe('a get', () => {
  it('returns the value the agent holds, typed', async () => {
    const session = open();
    try {
      const [varbind] = await session.get([SYS_DESCR], live());
      assert.ok(varbind);
      assert.equal(varbind.oid, SYS_DESCR);
      assert.equal(varbind.type, 'OctetString');
      assert.equal(stringOf(varbind), 'ms-target router');
    } finally {
      session.close();
    }
  });

  it('keeps a 64-bit counter exact, which a number could not', async () => {
    // 18446744073709551000 is past 2^53. As a `number` it would round, and T-02 computes traffic
    // from deltas between two of these — a rounded counter is quiet nonsense on a busy link.
    const session = open();
    try {
      const [varbind] = await session.get([`${IF_HC_IN}.2`], live());
      assert.ok(varbind);
      assert.equal(varbind.type, 'Counter64');
      assert.equal(varbind.value, 18_446_744_073_709_551_000n);
    } finally {
      session.close();
    }
  });

  it('reports a missing object as an exception rather than as a value', async () => {
    const session = open();
    try {
      const [varbind] = await session.get(['1.3.6.1.4.1.99999.1.0'], live());
      assert.ok(varbind);
      assert.equal(varbind.type, 'NoSuchObject');
      assert.equal(isException(varbind), true);
      // Not zero. "The agent has no such object" and "the counter is zero" are different facts,
      // and a Down sensor records no value at all (CLAUDE.md).
      assert.equal(numberOf(varbind), null);
      assert.equal(stringOf(varbind), null);
    } finally {
      session.close();
    }
  });

  it('asks for several OIDs in one request', async () => {
    const session = open();
    agent.resetCounters();
    try {
      const varbinds = await session.get([SYS_DESCR, '1.3.6.1.2.1.1.3.0'], live());
      assert.equal(varbinds.length, 2);
      assert.equal(agent.requests, 1);
    } finally {
      session.close();
    }
  });

  it('normalises the OID it is given, so a leading dot is not a different object', async () => {
    const session = open();
    try {
      const [varbind] = await session.get([`.${SYS_DESCR}`], live());
      assert.ok(varbind);
      assert.equal(varbind.oid, SYS_DESCR);
    } finally {
      session.close();
    }
  });

  it('refuses an OID that is not one, before sending anything', async () => {
    const session = open();
    agent.resetCounters();
    try {
      await assert.rejects(() => session.get(['1.3.6.four.1'], live()), /not an OID/);
      assert.equal(agent.requests, 0);
    } finally {
      session.close();
    }
  });
});

describe('a walk', () => {
  it('collects the subtree and stops at its edge', async () => {
    const session = open();
    try {
      const varbinds = await session.walk(IF_DESCR, live());
      assert.deepEqual(
        varbinds.map((v) => stringOf(v)),
        ['lo', 'eth0', 'eth1'],
      );
    } finally {
      session.close();
    }
  });

  it('does not leak into a sibling subtree whose text starts the same way', async () => {
    // 1.3.6.1.2.1.2 must not swallow 1.3.6.1.2.1.25.*. String prefixing gets this wrong; only
    // comparing arc by arc does not.
    const session = open();
    try {
      const varbinds = await session.walk('1.3.6.1.2.1.2', live());
      assert.ok(varbinds.length > 0);
      assert.ok(varbinds.every((v) => !v.oid.startsWith('1.3.6.1.2.1.25')));
    } finally {
      session.close();
    }
  });

  it('returns nothing for a subtree the agent does not have', async () => {
    const session = open();
    try {
      assert.deepEqual(await session.walk('1.3.6.1.4.1.99999', live()), []);
    } finally {
      session.close();
    }
  });

  it('fails rather than spinning when the agent walks backwards', async () => {
    // A broken agent answering GetNext with an OID it already gave is an infinite loop holding a
    // worker for ever. It has to be an error, and it has to say the agent is at fault.
    agent.behave({ nonIncreasingOid: `${IF_DESCR}.1` });
    const session = open();
    try {
      await assert.rejects(
        () => session.walk(IF_DESCR, live()),
        (error: unknown) =>
          error instanceof SnmpError &&
          error.phase === 'walk' &&
          /does not come after|not walking its MIB in order/.test(error.message),
      );
    } finally {
      session.close();
    }
  });

  it('fails rather than truncating when a subtree passes the bound', async () => {
    // Truncating would read as a device that lost interfaces. The error names the limit and what
    // to do about it.
    agent.load(
      Array.from({ length: 40 }, (_, index) => ({
        oid: `${IF_DESCR}.${String(index + 1)}`,
        type: 'Integer' as const,
        value: index,
      })),
    );
    const session = open({ maxVarbinds: 10 });
    try {
      await assert.rejects(
        () => session.walk(IF_DESCR, live()),
        (error: unknown) => error instanceof SnmpError && /passed 10 values/.test(error.message),
      );
    } finally {
      session.close();
    }
  });
});

describe('a getBulk', () => {
  it('returns one row per repeated OID', async () => {
    const session = open();
    try {
      const rows = await session.getBulk([IF_DESCR], live(), 0, 3);
      assert.equal(rows.length, 1);
      assert.deepEqual(
        (rows[0] ?? []).map((v) => stringOf(v)),
        ['lo', 'eth0', 'eth1'],
      );
    } finally {
      session.close();
    }
  });
});

describe('when the agent does not answer', () => {
  it('says what it means, not "Request timed out"', async () => {
    agent.behave({ silent: true });
    const session = open({ timeoutMs: 150, retries: 0 });
    try {
      await assert.rejects(
        () => session.get([SYS_DESCR], live()),
        (error: unknown) =>
          error instanceof SnmpError &&
          error.host === agent.host &&
          error.phase === 'get' &&
          error.oid === SYS_DESCR &&
          // A silent agent is what a wrong community string looks like, and an operator staring
          // at a reachable device needs to be told that.
          /wrong community string/.test(error.message),
      );
    } finally {
      session.close();
    }
  });

  it('retries a lost datagram, because UDP loses them', async () => {
    agent.behave({ dropFirst: 1 });
    const session = open({ timeoutMs: 200, retries: 1 });
    try {
      const [varbind] = await session.get([SYS_DESCR], live());
      assert.ok(varbind);
      assert.equal(stringOf(varbind), 'ms-target router');
      assert.equal(agent.requests, 2, 'the first request should have been dropped and resent');
    } finally {
      session.close();
    }
  });

  it('gives up after the retries are spent', async () => {
    agent.behave({ dropFirst: 5 });
    const session = open({ timeoutMs: 120, retries: 1 });
    try {
      await assert.rejects(() => session.get([SYS_DESCR], live()), SnmpError);
      assert.equal(agent.requests, 2, 'one attempt plus one retry');
    } finally {
      session.close();
    }
  });

  it('states the worst case rather than the per-attempt timeout', () => {
    // The trap this exists for: 5,000 ms with two retries is fifteen seconds, and a check whose
    // deadline was set from the timeout alone would be killed two thirds of the way through.
    assert.equal(worstCaseMs({ timeoutMs: 5_000, retries: 2 }), 15_000);
    assert.equal(worstCaseMs({ timeoutMs: 1_000, retries: 0 }), 1_000);
  });
});

describe('when the community is wrong', () => {
  it('times out, because that is what an agent does about it', async () => {
    // Not a rejection on the wire: an agent silently ignores a bad community, so this is
    // indistinguishable from unreachable — which is exactly why the timeout message says so.
    agent.accept('not-public');
    const session = open({ timeoutMs: 150, retries: 0 });
    try {
      await assert.rejects(() => session.get([SYS_DESCR], live()), SnmpError);
    } finally {
      session.close();
    }
  });
});

describe('an error-status reply', () => {
  it('is reported with the host and the phase', async () => {
    agent.behave({ errorStatus: 2 });
    const session = open();
    try {
      await assert.rejects(
        () => session.get([SYS_DESCR], live()),
        (error: unknown) =>
          error instanceof SnmpError && error.host === agent.host && error.phase === 'get',
      );
    } finally {
      session.close();
    }
  });
});

describe('abort', () => {
  it('returns promptly rather than waiting out the timeout', async () => {
    agent.behave({ silent: true });
    const controller = new AbortController();
    // Ten seconds of timeout: if abort were not honoured, this test would take ten seconds.
    const session = open({ timeoutMs: 10_000, retries: 0 });
    try {
      const started = Date.now();
      const pending = session.get([SYS_DESCR], controller.signal);
      setTimeout(() => {
        controller.abort();
      }, 50);
      await assert.rejects(() => pending, /cancelled/);
      assert.ok(Date.now() - started < 2_000, 'abort should not wait for the SNMP timeout');
    } finally {
      session.close();
    }
  });

  it('refuses before sending when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = open();
    agent.resetCounters();
    try {
      await assert.rejects(() => session.get([SYS_DESCR], controller.signal), /cancelled/);
      assert.equal(agent.requests, 0);
    } finally {
      session.close();
    }
  });

  it('leaves the session usable, because it is shared', async () => {
    // The point of the whole design: aborting one check must not close a socket other sensors on
    // the same device are mid-request on.
    const session = open({ timeoutMs: 10_000, retries: 0 });
    try {
      agent.behave({ silent: true });
      const controller = new AbortController();
      const pending = session.get([SYS_DESCR], controller.signal);
      controller.abort();
      await assert.rejects(() => pending, /cancelled/);

      agent.behave({});
      const [varbind] = await session.get([SYS_DESCR], live());
      assert.ok(varbind);
      assert.equal(stringOf(varbind), 'ms-target router');
      assert.equal(session.closed, false);
    } finally {
      session.close();
    }
  });
});

describe('a closed session', () => {
  it('refuses further requests instead of failing on the socket', async () => {
    const session = open();
    session.close();
    await assert.rejects(() => session.get([SYS_DESCR], live()), /is closed/);
  });

  it('can be closed twice', () => {
    const session = open();
    session.close();
    session.close();
    assert.equal(session.closed, true);
  });
});

describe('opening', () => {
  it('refuses a device with no host rather than querying nothing', () => {
    assert.throws(
      () => SnmpSession.open({ host: '   ' }, V2C),
      (error: unknown) => error instanceof SnmpError && error.phase === 'connect',
    );
  });
});
