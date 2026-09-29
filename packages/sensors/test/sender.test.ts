import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  canonicalAddress,
  DeviceAddresses,
  fromDevice,
  RESOLVE_TTL_MS,
  type Lookup,
} from '../src/support/sender.js';

/**
 * The one resolver the three listener types share (`P-246`).
 *
 * The sockets are in each type's own tests; this is the part with the decisions in it — which
 * spellings are one address, and when the resolver is asked — against a lookup the test answers.
 */

/** A lookup that answers from a script, one entry per call, and records what it was asked. */
function scripted(...answers: (readonly string[] | Error)[]): { lookup: Lookup; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    lookup: (name) => {
      asked.push(name);
      const answer = answers.shift() ?? new Error('the test gave no more answers');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

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

describe('a device’s addresses (`P-246`)', () => {
  it('resolves a name to every address it stands for, each in the one form', async () => {
    const { lookup, asked } = scripted(['10.0.0.1', '2001:DB8::1', '::ffff:10.0.0.2']);
    const addresses = await new DeviceAddresses({ lookup }).of(' core-sw1.example ');
    assert.deepEqual([...addresses], ['10.0.0.1', '2001:db8::1', '10.0.0.2']);
    assert.deepEqual(asked, ['core-sw1.example']);
  });

  it('asks nothing for a literal address, of either family', async () => {
    const { lookup, asked } = scripted();
    const addresses = new DeviceAddresses({ lookup });
    assert.deepEqual([...(await addresses.of('10.0.0.1'))], ['10.0.0.1']);
    assert.deepEqual([...(await addresses.of('2001:DB8:0::1'))], ['2001:db8::1']);
    assert.deepEqual([...(await addresses.of('::ffff:10.0.0.3'))], ['10.0.0.3']);
    assert.deepEqual(asked, []);
  });

  it('asks once per name for five minutes, whatever case it is written in', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { lookup, asked } = scripted(['10.0.0.1'], ['10.0.0.9']);
    const addresses = new DeviceAddresses({ lookup });

    assert.deepEqual([...(await addresses.of('core-sw1'))], ['10.0.0.1']);
    assert.deepEqual([...(await addresses.of('CORE-SW1'))], ['10.0.0.1']);
    t.mock.timers.tick(RESOLVE_TTL_MS - 1);
    assert.deepEqual([...(await addresses.of('core-sw1'))], ['10.0.0.1']);
    assert.equal(asked.length, 1);

    // Renumbered: the next answer after the five minutes is the new one.
    t.mock.timers.tick(1);
    assert.deepEqual([...(await addresses.of('core-sw1'))], ['10.0.0.9']);
    assert.equal(asked.length, 2);
  });

  it('keeps each name’s answer to itself', async () => {
    const { lookup } = scripted(['10.0.0.1'], ['10.0.0.2']);
    const addresses = new DeviceAddresses({ lookup });
    await addresses.of('core-sw1');
    assert.deepEqual([...(await addresses.of('core-sw2'))], ['10.0.0.2']);
  });

  it('asks again after a name failed to resolve, rather than remembering the failure', async () => {
    // A remembered failure would fail every scan for five minutes after DNS came back.
    const { lookup, asked } = scripted(new Error('ENOTFOUND core-sw1'), ['10.0.0.1']);
    const addresses = new DeviceAddresses({ lookup });
    assert.equal((await addresses.of('core-sw1')).size, 0);
    assert.deepEqual([...(await addresses.of('core-sw1'))], ['10.0.0.1']);
    assert.equal(asked.length, 2);
  });

  it('asks again after an answer with no addresses in it, too', async () => {
    const { lookup, asked } = scripted([], ['10.0.0.1']);
    const addresses = new DeviceAddresses({ lookup });
    assert.equal((await addresses.of('core-sw1')).size, 0);
    assert.deepEqual([...(await addresses.of('core-sw1'))], ['10.0.0.1']);
    assert.equal(asked.length, 2);
  });

  it('has no address for a blank host, and asks nobody', async () => {
    const { lookup, asked } = scripted();
    assert.equal((await new DeviceAddresses({ lookup }).of('  ')).size, 0);
    assert.deepEqual(asked, []);
  });

  it('takes a shorter memory when told to', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const { lookup, asked } = scripted(['10.0.0.1'], ['10.0.0.1']);
    const addresses = new DeviceAddresses({ lookup, ttlMs: 10 });
    await addresses.of('core-sw1');
    t.mock.timers.tick(10);
    await addresses.of('core-sw1');
    assert.equal(asked.length, 2);
  });
});

describe('whether a sender is the device (`P-246`)', () => {
  it('fails naming the host, rather than matching nothing, when the name stands for nothing', async () => {
    const { lookup } = scripted(new Error('ENOTFOUND'));
    await assert.rejects(
      () => fromDevice('core-sw1.example', 'messages', new DeviceAddresses({ lookup })),
      (error: Error) => {
        assert.match(error.message, /counts only messages from core-sw1\.example/);
        assert.match(error.message, /did not resolve to any address/);
        return true;
      },
    );
  });

  it('compares the sender in the same form as the device', async () => {
    const { lookup } = scripted(['10.0.0.1', '2001:db8::1']);
    const isDevice = await fromDevice('core-sw1', 'messages', new DeviceAddresses({ lookup }));
    assert.equal(isDevice('::ffff:10.0.0.1'), true, 'an IPv4 sender on a dual-stack listener');
    assert.equal(isDevice('2001:DB8:0::1'), true);
    assert.equal(isDevice('10.0.0.2'), false);
  });
});
