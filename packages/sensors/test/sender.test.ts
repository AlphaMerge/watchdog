import { strict as assert } from 'node:assert';
import { isIP } from 'node:net';
import { describe, it } from 'node:test';
import {
  LookupCount,
  RESOLVER_BUSY,
  RESOLVER_HELD,
  RESOLVER_TOO_MANY,
} from '../src/support/lookups.js';
import type { ResolveHost } from '../src/support/pinned-target.js';
import { canonicalAddress, fromDevice, senderLookup } from '../src/support/sender.js';

/**
 * The one resolver the three listener types share (`P-246`).
 *
 * The sockets are in each type's own tests; this is the part with the decisions in it — which
 * spellings are one address, and how the device's name is resolved (`P-425`) — against a
 * resolver the test answers.
 */

describe('one form for a sender and a device (`P-246`)', () => {
  const cases: [string, string, string][] = [
    // What a listener bound to `::` reports for an IPv4 sender, in every spelling of it.
    ['::ffff:127.0.0.1', '127.0.0.1', 'dual-stack IPv4 sender'],
    ['::FFFF:10.1.1.1', '10.1.1.1', 'mapped, upper case'],
    ['0:0:0:0:0:ffff:c0a8:0102', '192.168.1.2', 'mapped, in hex and uncompressed'],
    ['::ffff:ff00:ff', '255.0.0.255', 'each octet from its own half of each word'],
    // Only `::ffff:0:0/96` is mapped. Anything else ending in two words is an IPv6 address.
    ['1::ffff:a01:101', '1::ffff:a01:101', 'not mapped: a prefix before the ffff'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1', 'IPv6, as an operator might type it'],
    ['0:0:0:0:0:0:0:1', '::1', 'loopback, uncompressed'],
    ['2001:db8::1', '2001:db8::1', 'IPv6, already canonical'],
    ['fe80::A%eth0', 'fe80::a%eth0', 'a zone is kept, because it names the link'],
    [' 10.0.0.1 ', '10.0.0.1', 'IPv4, trimmed'],
    ['unknown', 'unknown', 'not an address, left to match nothing'],
  ];
  for (const [given, expected, why] of cases) {
    it(`${why}: ${given.trim()} is ${expected}`, () => {
      assert.equal(canonicalAddress(given), expected);
    });
  }
});

describe('whether a sender is the device (`P-246`, `P-425`)', () => {
  const answering =
    (...addresses: string[]): ResolveHost =>
    () =>
      Promise.resolve(addresses.map((address) => ({ address, family: isIP(address) })));
  const failing =
    (code: string): ResolveHost =>
    (host) =>
      Promise.reject(Object.assign(new Error(`getaddrinfo ${code} ${host}`), { code }));
  const never: ResolveHost = () => new Promise(() => undefined);

  it('resolves a name to every address it stands for, each in the one form', async () => {
    const asked: { host: string; family: number; waitMs: number | undefined }[] = [];
    const resolve: ResolveHost = (host, family, options) => {
      asked.push({ host, family, waitMs: options?.waitMs });
      return answering('10.0.0.1', '2001:DB8::1', '::ffff:10.0.0.2')(host, family);
    };
    const isDevice = await fromDevice(' core-sw1.example ', 'messages', {
      resolve,
      timeoutMs: 4_000,
    });
    assert.deepEqual(asked, [{ host: 'core-sw1.example', family: 0, waitMs: 2_000 }]);
    assert.equal(isDevice('10.0.0.1'), true);
    assert.equal(isDevice('2001:db8::1'), true);
    assert.equal(isDevice('::ffff:10.0.0.2'), true, 'an IPv4 sender on a dual-stack listener');
    assert.equal(isDevice('10.0.0.3'), false);
  });

  it('asks nothing for a literal address, of either family', async () => {
    let asked = 0;
    const resolve: ResolveHost = () => {
      asked += 1;
      return Promise.resolve([]);
    };
    assert.equal((await fromDevice('10.0.0.1', 'messages', { resolve }))('10.0.0.1'), true);
    assert.equal((await fromDevice('2001:DB8:0::1', 'messages', { resolve }))('2001:db8::1'), true);
    assert.equal((await fromDevice('::ffff:10.0.0.3', 'messages', { resolve }))('10.0.0.3'), true);
    assert.equal(asked, 0);
  });

  it('asks the check’s resolver every time: answers are kept by the probe’s, not here', async () => {
    let asked = 0;
    const resolve: ResolveHost = (host, family) => {
      asked += 1;
      return answering('10.0.0.1')(host, family);
    };
    await fromDevice('core-sw1', 'messages', { resolve });
    await fromDevice('core-sw1', 'messages', { resolve });
    assert.equal(asked, 2);
  });

  it('fails naming the host, rather than matching nothing, when the name stands for nothing', async () => {
    for (const resolve of [failing('ENOTFOUND'), answering()]) {
      const count = new LookupCount();
      await assert.rejects(
        () => fromDevice('core-sw1.example', 'messages', { resolve, counted: count }),
        (error: Error) => {
          assert.match(error.message, /counts only messages from core-sw1\.example/);
          assert.match(error.message, /did not resolve to any address/);
          assert.equal((error as { phase?: unknown }).phase, 'resolve');
          return true;
        },
      );
      assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 }, 'an answer, not given up');
    }
  });

  it('has no address for a blank host, and asks nobody', async () => {
    let asked = 0;
    const resolve: ResolveHost = () => {
      asked += 1;
      return Promise.resolve([]);
    };
    await assert.rejects(() => fromDevice('  ', 'messages', { resolve }), /did not resolve/);
    assert.equal(asked, 0);
  });

  it('fails at its bound when the resolver does not answer, saying so, and counts the lookup', async () => {
    const count = new LookupCount();
    const started = performance.now();
    await assert.rejects(
      () =>
        fromDevice('core-sw1.example', 'flows', { resolve: never, timeoutMs: 400, counted: count }),
      (error: Error) => {
        assert.equal(
          error.message,
          'this sensor counts only flows from core-sw1.example, and that name did not resolve ' +
            'within 200 ms — the probe’s resolver is not answering — so nothing could be ' +
            'attributed to this device. Give the device a literal address, or turn off “only ' +
            'this device”',
        );
        assert.equal((error as { phase?: unknown }).phase, 'resolve');
        return true;
      },
    );
    assert.ok(performance.now() - started < 2_000, 'at the bound, half the check’s 400 ms');
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 1 }, 'in flight, and given up');
  });

  it('stops waiting when the check is cancelled', async () => {
    const count = new LookupCount();
    const controller = new AbortController();
    const waited = fromDevice('core-sw1', 'messages', {
      resolve: never,
      signal: controller.signal,
      counted: count,
    });
    controller.abort();
    await assert.rejects(waited, /cancelled while core-sw1 was being resolved/);
    assert.deepEqual(count.stats(), { inFlight: 1, givenUp: 1 });
  });

  it('fails at once naming the resolver for a name the probe holds, and counts it given up', async () => {
    const count = new LookupCount();
    await assert.rejects(
      () => fromDevice('core-sw1', 'messages', { resolve: failing(RESOLVER_HELD), counted: count }),
      /did not resolve — the probe’s resolver is not answering \(getaddrinfo ERESOLVERHELD core-sw1\)/,
    );
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 1 });
  });

  it('says a probe too busy to ask is the probe, and does not count it given up', async () => {
    const count = new LookupCount();
    await assert.rejects(
      () => fromDevice('core-sw1', 'messages', { resolve: failing(RESOLVER_BUSY), counted: count }),
      /could not be resolved \(getaddrinfo ERESOLVERBUSY core-sw1\)/,
    );
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 });
  });

  it('passes on the resolver’s words for a name with more addresses than the probe uses', async () => {
    // `P-426`'s review: the resolver keeps this as a denial, and "no address" would say the
    // opposite of what happened and drop the count.
    const count = new LookupCount();
    const resolve: ResolveHost = () =>
      Promise.reject(
        Object.assign(
          new Error(
            'core-sw1 resolved to 65 addresses, more than the 64 the probe uses for one name',
          ),
          { code: RESOLVER_TOO_MANY },
        ),
      );
    await assert.rejects(
      () => fromDevice('core-sw1', 'messages', { resolve, counted: count }),
      (error: Error) => {
        assert.match(
          error.message,
          /that name could not be used \(core-sw1 resolved to 65 addresses, more than the 64/,
        );
        assert.doesNotMatch(error.message, /did not resolve/);
        assert.equal((error as { phase?: unknown }).phase, 'resolve');
        return true;
      },
    );
    assert.deepEqual(count.stats(), { inFlight: 0, givenUp: 0 }, 'an answer, not given up');
  });

  it('takes the check’s resolver, signal and deadline from its context', () => {
    const controller = new AbortController();
    const resolve = never;
    assert.deepEqual(
      senderLookup({ target: { resolve }, signal: controller.signal, timeoutMs: 30_000 }),
      { resolve, signal: controller.signal, timeoutMs: 30_000 },
    );
  });
});
