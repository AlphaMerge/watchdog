import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LookupAddress } from 'node:dns';
import {
  CREDENTIALS_WITHHELD,
  CredentialsWithheldError,
  pinnedLookup,
  pinnedPeerRefusal,
  pinTarget,
  type PinRequest,
  type ResolvedAddress,
  type ResolveHost,
} from '../src/support/pinned-target.js';

/**
 * `pinTarget` against a resolver the test owns (`A-41c`).
 *
 * No name here is ever handed to the system resolver: each test says what the name resolves to,
 * and counts how often it was asked. The count is half of what is being proved. A check that
 * needs no pin must not ask at all, and one that does must ask exactly once.
 */

interface Recorded {
  readonly resolve: ResolveHost;
  readonly calls: { host: string; family: number }[];
}

/** A resolver answering from a list of answers, one per call, the last repeating. */
function resolver(...answers: (readonly ResolvedAddress[] | Error)[]): Recorded {
  const calls: { host: string; family: number }[] = [];
  return {
    calls,
    resolve: (host, family) => {
      const answer = answers[Math.min(calls.length, answers.length - 1)] ?? [];
      calls.push({ host, family });
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer.filter((entry) => family === 0 || entry.family === family));
    },
  };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

function request(over: Partial<PinRequest> = {}): PinRequest {
  return {
    sensorId: 41,
    target: { host: 'switch.example.test', ipVersion: 'auto' },
    credentials: { snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] } },
    pinnedKinds: ['snmp'],
    ...over,
  };
}

async function refusal(input: PinRequest, resolve: ResolveHost): Promise<CredentialsWithheldError> {
  try {
    await pinTarget(input, resolve);
  } catch (error: unknown) {
    assert.ok(error instanceof CredentialsWithheldError, `threw ${String(error)}`);
    return error;
  }
  return assert.fail('the set was not refused');
}

describe('a check that needs no pin resolves nothing', () => {
  it('an unrestricted set, for a named device', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const pinned = await pinTarget(
      request({ credentials: { snmp: { community: 'public' } } }),
      dns.resolve,
    );
    assert.equal(pinned, null);
    assert.equal(dns.calls.length, 0);
  });

  it('a set whose targets list is empty', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const pinned = await pinTarget(
      request({ credentials: { snmp: { community: 'public', allowedTargets: [] } } }),
      dns.resolve,
    );
    assert.equal(pinned, null);
    assert.equal(dns.calls.length, 0);
  });

  it('no credentials at all', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    assert.equal(await pinTarget(request({ credentials: {} }), dns.resolve), null);
    assert.equal(dns.calls.length, 0);
  });

  it('a device given as an address inside the targets', async () => {
    const dns = resolver([v4('192.0.2.1')]);
    const pinned = await pinTarget(
      request({ target: { host: '10.20.3.4', ipVersion: 'auto' } }),
      dns.resolve,
    );
    assert.equal(pinned, null);
    assert.equal(dns.calls.length, 0);
  });

  it('a named device that a name entry covers, beside address entries', async () => {
    const dns = resolver([v4('192.0.2.1')]);
    const pinned = await pinTarget(
      request({
        credentials: {
          snmp: { community: 'public', allowedTargets: ['10.20.0.0/16', '*.example.test'] },
        },
      }),
      dns.resolve,
    );
    assert.equal(pinned, null);
    assert.equal(dns.calls.length, 0);
  });
});

describe('a named device against address targets', () => {
  it('is pinned to an address when every address it has is inside', async () => {
    const dns = resolver([v4('10.20.0.5'), v4('10.20.0.6')]);
    const pinned = await pinTarget(request(), dns.resolve);
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
    assert.deepEqual(dns.calls, [{ host: 'switch.example.test', family: 0 }]);
  });

  it('is refused when any one address is outside, naming it', async () => {
    // The first is inside. A check of the first alone would have passed, and the name's owner
    // chooses which record a connection gets.
    const dns = resolver([v4('10.20.0.5'), v4('192.0.2.77')]);
    const error = await refusal(request(), dns.resolve);
    assert.match(error.message, /^Not scanned: switch\.example\.test resolves to 192\.0\.2\.77/);
    assert.match(error.message, /outside the allowed targets of the snmp credentials/);
    assert.equal(error.code, CREDENTIALS_WITHHELD);
    assert.equal(error.sensorId, 41);
    assert.equal(error.target, 'switch.example.test');
    assert.equal(error.phase, 'check');
    assert.equal(error.kind, 'snmp');
    assert.equal(dns.calls.length, 1);
  });

  it('is refused when the only address is outside', async () => {
    const dns = resolver([v4('192.0.2.77')]);
    const error = await refusal(request(), dns.resolve);
    assert.match(error.message, /resolves to 192\.0\.2\.77/);
  });

  it('is refused when the name resolves to nothing', async () => {
    const dns = resolver([]);
    const error = await refusal(request(), dns.resolve);
    assert.match(
      error.message,
      /^Not scanned: switch\.example\.test did not resolve to any address, so it could not be checked/,
    );
    assert.equal(error.phase, 'resolve');
    assert.equal(error.sensorId, 41);
    assert.equal(error.target, 'switch.example.test');
  });

  it('is refused when the name does not resolve, with the resolver’s reason', async () => {
    const dns = resolver(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const error = await refusal(request(), dns.resolve);
    assert.match(error.message, /did not resolve to any address \(ENOTFOUND\)/);
    assert.equal(error.phase, 'resolve');
  });

  it('is refused when what the resolver answered is not an address', async () => {
    const dns = resolver([{ address: 'inside.example.test', family: 4 }]);
    const error = await refusal(request(), dns.resolve);
    assert.match(error.message, /did not resolve to any address/);
  });

  it('asks the resolver once, whatever it would say the second time', async () => {
    // Rebinding: inside for the check, outside for whoever asks next. Nobody asks next.
    const dns = resolver([v4('10.20.0.5')], [v4('192.0.2.77')]);
    const pinned = await pinTarget(request(), dns.resolve);
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
    assert.equal(dns.calls.length, 1);
  });
});

describe('address families', () => {
  const both = [v6('fd00:1::5'), v4('10.20.0.5')];
  const targets = {
    snmp: { community: 'public', allowedTargets: ['10.20.0.0/16', 'fd00:1::/64'] },
  };

  it('auto checks both families, and one outside in either refuses', async () => {
    const dns = resolver([v4('10.20.0.5'), v6('2001:db8::1')]);
    const error = await refusal(request({ credentials: targets }), dns.resolve);
    assert.match(error.message, /resolves to 2001:db8::1/);
    assert.deepEqual(dns.calls, [{ host: 'switch.example.test', family: 0 }]);
  });

  it('auto prefers IPv4 when both are inside', async () => {
    const dns = resolver(both);
    const pinned = await pinTarget(request({ credentials: targets }), dns.resolve);
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
  });

  it('auto pins IPv6 when that is all the name has', async () => {
    const dns = resolver([v6('fd00:1::5')]);
    const pinned = await pinTarget(request({ credentials: targets }), dns.resolve);
    assert.deepEqual(pinned, { address: 'fd00:1::5', family: 6 });
  });

  it('a v4 device asks for IPv4 only, and an IPv6 record outside does not refuse it', async () => {
    // The connection is never made over IPv6, so that record cannot receive the set.
    const dns = resolver([v4('10.20.0.5'), v6('2001:db8::1')]);
    const pinned = await pinTarget(
      request({ target: { host: 'switch.example.test', ipVersion: 'v4' } }),
      dns.resolve,
    );
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
    assert.deepEqual(dns.calls, [{ host: 'switch.example.test', family: 4 }]);
  });

  it('a v6 device asks for IPv6 only, and is pinned to it', async () => {
    const dns = resolver(both);
    const pinned = await pinTarget(
      request({ target: { host: 'switch.example.test', ipVersion: 'v6' }, credentials: targets }),
      dns.resolve,
    );
    assert.deepEqual(pinned, { address: 'fd00:1::5', family: 6 });
    assert.deepEqual(dns.calls, [{ host: 'switch.example.test', family: 6 }]);
  });

  it('a v6 device whose name has only IPv4 is refused, saying which family', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(
      request({ target: { host: 'switch.example.test', ipVersion: 'v6' } }),
      dns.resolve,
    );
    assert.match(error.message, /did not resolve to any IPv6 address/);
  });

  it('does not believe a resolver that answers with a family it was not asked for', async () => {
    // Asked for IPv4, it answers with an IPv6 address inside the targets. Not a candidate.
    const dns: ResolveHost = () => Promise.resolve([v6('fd00:1::5')]);
    const error = await refusal(
      request({ target: { host: 'switch.example.test', ipVersion: 'v4' }, credentials: targets }),
      dns,
    );
    assert.match(error.message, /did not resolve to any IPv4 address/);
  });

  it('an IPv4-mapped answer is the IPv4 address it is', async () => {
    const dns = resolver([v6('::ffff:10.20.0.5')]);
    const pinned = await pinTarget(request(), dns.resolve);
    assert.deepEqual(pinned, { address: '::ffff:10.20.0.5', family: 6 });
    const outside = resolver([v6('::ffff:192.0.2.1')]);
    await refusal(request(), outside.resolve);
  });
});

describe('what is refused before anything is resolved', () => {
  it('a device given as an address outside the targets', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(
      request({ target: { host: '192.0.2.9', ipVersion: 'auto' } }),
      dns.resolve,
    );
    assert.match(error.message, /^Not scanned: 192\.0\.2\.9 is outside the allowed targets/);
    assert.equal(error.phase, 'check');
    assert.equal(dns.calls.length, 0);
  });

  it('a named device no name entry covers, when the targets name only names', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(
      request({ credentials: { snmp: { community: 'public', allowedTargets: ['*.other.test'] } } }),
      dns.resolve,
    );
    assert.match(error.message, /is outside the allowed targets/);
    assert.equal(dns.calls.length, 0);
  });

  it('a kind the sensor type does not pin', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(
      request({
        credentials: { database: { username: 'ms', allowedTargets: ['10.20.0.0/16'] } },
        pinnedKinds: [],
      }),
      dns.resolve,
    );
    assert.match(error.message, /this kind of sensor cannot be held to an address/);
    assert.equal(error.kind, 'database');
    assert.equal(dns.calls.length, 0);
  });

  it('a pinned kind does not excuse another the type does not pin', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(
      request({
        credentials: {
          database: { username: 'ms', allowedTargets: ['10.20.0.0/16'] },
          snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] },
        },
        pinnedKinds: ['snmp'],
      }),
      dns.resolve,
    );
    assert.equal(error.kind, 'database');
    assert.equal(dns.calls.length, 0);
  });
});

describe('more than one restricted set', () => {
  const two = (ssh: string[]): PinRequest =>
    request({
      credentials: {
        snmp: { community: 'public', allowedTargets: ['10.20.0.0/16'] },
        ssh: { username: 'ms', allowedTargets: ssh },
      },
      pinnedKinds: ['snmp', 'ssh'],
    });

  it('every address must be inside every set that needs the check', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const error = await refusal(two(['10.99.0.0/16']), dns.resolve);
    assert.match(error.message, /outside the allowed targets of the ssh credentials/);
    assert.equal(dns.calls.length, 1);
  });

  it('one resolution serves them all', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const pinned = await pinTarget(two(['10.20.0.5']), dns.resolve);
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
    assert.equal(dns.calls.length, 1);
  });

  it('a set a name entry covers does not need the address inside it', async () => {
    const dns = resolver([v4('10.20.0.5')]);
    const pinned = await pinTarget(two(['switch.example.test']), dns.resolve);
    assert.deepEqual(pinned, { address: '10.20.0.5', family: 4 });
  });
});

describe('a cancelled check', () => {
  it('is refused without waiting for a resolver that never answers', async () => {
    const controller = new AbortController();
    const never: ResolveHost = () => new Promise(() => undefined);
    const pending = refusal(request({ signal: controller.signal }), never);
    controller.abort();
    const error = await pending;
    assert.match(
      error.message,
      /the check was cancelled while switch\.example\.test was being resolved/,
    );
    assert.equal(error.phase, 'resolve');
  });

  it('is refused at once when it was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const dns = resolver(new Error('late'));
    const error = await refusal(request({ signal: controller.signal }), dns.resolve);
    assert.match(error.message, /cancelled/);
  });
});

describe('the lookup a socket is given', () => {
  const pinned = { address: '10.20.0.5', family: 4 } as const;
  type Answer = { error: Error | null; address: string | LookupAddress[]; family?: number };
  const ask = (hostname: string, all: boolean): Answer => {
    let answer: Answer | undefined;
    pinnedLookup('Switch.Example.Test', pinned)(hostname, { all }, (error, address, family) => {
      answer = { error, address, ...(family === undefined ? {} : { family }) };
    });
    assert.ok(answer !== undefined, 'the lookup did not answer synchronously');
    return answer;
  };

  it('answers the device’s name with the checked address', () => {
    assert.deepEqual(ask('switch.example.test', false), {
      error: null,
      address: '10.20.0.5',
      family: 4,
    });
  });

  it('answers a lookup for every address with the one checked', () => {
    assert.deepEqual(ask('switch.example.test.', true), {
      error: null,
      address: [{ address: '10.20.0.5', family: 4 }],
    });
  });

  it('refuses any other name, and resolves nothing for it', () => {
    const answer = ask('proxy.example.test', false);
    assert.ok(answer.error instanceof CredentialsWithheldError);
    assert.match(answer.error.message, /asked to resolve proxy\.example\.test/);
    assert.equal(answer.error.phase, 'connect');
    assert.equal(answer.error.target, 'Switch.Example.Test');
  });
});

describe('where a connection went', () => {
  const pinned = { address: '10.20.0.5', family: 4 } as const;

  it('is accepted at the checked address, in either spelling', () => {
    assert.equal(pinnedPeerRefusal('h', pinned, '10.20.0.5'), null);
    assert.equal(pinnedPeerRefusal('h', pinned, '::ffff:10.20.0.5'), null);
    assert.equal(
      pinnedPeerRefusal('h', { address: 'fd00:1::5', family: 6 }, 'fd00:1:0:0:0:0:0:5'),
      null,
    );
  });

  it('is refused anywhere else, saying where', () => {
    const error = pinnedPeerRefusal('switch.example.test', pinned, '192.0.2.77');
    assert.ok(error !== null);
    assert.match(
      error.message,
      /the connection for switch\.example\.test went to 192\.0\.2\.77, not to 10\.20\.0\.5/,
    );
    assert.equal(error.phase, 'connect');
    assert.equal(error.target, 'switch.example.test');
  });

  it('is refused when the socket has no far end to ask', () => {
    const error = pinnedPeerRefusal('switch.example.test', pinned, undefined);
    assert.ok(error !== null);
    assert.match(error.message, /went to no address/);
  });

  it('a refusal a transport raised is given its sensor once', () => {
    const error = pinnedPeerRefusal('switch.example.test', pinned, '192.0.2.77');
    assert.ok(error !== null);
    assert.equal(error.sensorId, undefined);
    const named = error.forSensor(7);
    assert.equal(named.sensorId, 7);
    assert.equal(named.message, error.message);
    assert.equal(named.forSensor(8).sensorId, 7);
  });
});
