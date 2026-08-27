import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  addressAt,
  contains,
  IpRangeError,
  MAX_ADDRESSES,
  parseIpRange,
  toNumber,
  toText,
} from '../src/net/ip-range.js';

/**
 * What a discovery run sweeps (`D-01`).
 *
 * Shared between core and probe, so this is where the two agree about how big a range is. A
 * disagreement would surface as a progress bar that never reaches the end, which is the kind of
 * bug that gets lived with rather than reported.
 */

const size = (text: string): number => parseIpRange(text).size;
const addresses = (text: string): string[] => {
  const range = parseIpRange(text);
  const out: string[] = [];
  for (let at = 0; ; at += 1) {
    const value = addressAt(range, at);
    if (value === null) break;
    out.push(toText(value));
  }
  return out;
};

describe('the spellings an operator types', () => {
  it('reads one address', () => {
    assert.deepEqual(addresses('10.0.0.7'), ['10.0.0.7']);
  });

  it('reads a pair', () => {
    assert.deepEqual(addresses('10.0.0.1-10.0.0.4'), [
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.4',
    ]);
  });

  it('reads the last-octet shorthand, which is what everybody writes', () => {
    assert.deepEqual(addresses('10.0.0.5-8'), ['10.0.0.5', '10.0.0.6', '10.0.0.7', '10.0.0.8']);
  });

  it('reads a range that crosses an octet boundary', () => {
    assert.deepEqual(addresses('10.0.0.254-10.0.1.1'), [
      '10.0.0.254',
      '10.0.0.255',
      '10.0.1.0',
      '10.0.1.1',
    ]);
  });

  it('reads a comma-separated mix', () => {
    assert.deepEqual(addresses('10.0.0.1, 10.0.0.5-6, 192.168.1.0/30'), [
      '10.0.0.1',
      '10.0.0.5',
      '10.0.0.6',
      '192.168.1.1',
      '192.168.1.2',
    ]);
  });
});

describe('CIDR', () => {
  it('excludes the network and broadcast addresses', () => {
    // The one piece of cleverness here. Pinging .0 and .255 draws a reply from every host on
    // some networks and none on others, so including them would make a sweep's results depend
    // on the subnet's behaviour rather than on what is there.
    assert.equal(size('10.0.0.0/24'), 254);
    assert.deepEqual(addresses('10.0.0.0/29'), [
      '10.0.0.1',
      '10.0.0.2',
      '10.0.0.3',
      '10.0.0.4',
      '10.0.0.5',
      '10.0.0.6',
    ]);
  });

  it('keeps both addresses of a /31, because that is what a point-to-point link is', () => {
    // RFC 3021. A /31 with the usual rule applied would sweep nothing at all, which is the
    // silent-empty-result failure this whole file is about.
    assert.deepEqual(addresses('10.0.0.4/31'), ['10.0.0.4', '10.0.0.5']);
  });

  it('keeps the single address of a /32', () => {
    assert.deepEqual(addresses('10.0.0.9/32'), ['10.0.0.9']);
  });

  it('takes any address in the network, not only the network address', () => {
    // `10.0.0.37/24` is how somebody writes "the subnet this machine is on".
    assert.deepEqual(parseIpRange('10.0.0.37/24').spans, parseIpRange('10.0.0.0/24').spans);
  });

  it('reads a /16 without the shift going signed', () => {
    // `0xffffffff << 16` is negative in JavaScript, and a mask that came out negative would
    // make every address in the range wrong rather than the range empty.
    assert.equal(size('172.16.0.0/16'), 65_534);
    assert.deepEqual(addresses('172.16.0.0/16').slice(0, 2), ['172.16.0.1', '172.16.0.2']);
  });
});

describe('what it refuses', () => {
  it('refuses IPv6, and says why a sweep is the wrong tool for it', () => {
    assert.throws(
      () => parseIpRange('2001:db8::/64'),
      /eighteen million million million addresses/,
    );
    assert.throws(() => parseIpRange('::1'), IpRangeError);
  });

  it('refuses a range bigger than one run may sweep', () => {
    // The typo this catches is a /8 where a /24 was meant, which is sixteen million pings.
    assert.throws(() => parseIpRange('10.0.0.0/8'), /the usual cause is a \/8 where a \/24/);
    assert.equal(size('10.0.0.0/16'), 65_534, 'and a /16 is inside the bound');
  });

  it('refuses a backwards range rather than sweeping nothing', () => {
    assert.throws(() => parseIpRange('10.0.0.50-10.0.0.10'), /ends before it starts/);
  });

  it('refuses what is not an address', () => {
    for (const bad of ['', '  ', '10.0.0', '10.0.0.256', '10.0.0.a', 'server01', '10.0.0.0/33']) {
      assert.throws(() => parseIpRange(bad), IpRangeError, bad);
    }
  });

  it('refuses a shorthand end that is not an octet', () => {
    assert.throws(() => parseIpRange('10.0.0.1-999'), /not an address or an octet/);
  });
});

describe('overlaps', () => {
  it('counts an address once, however many times it was named', () => {
    // Otherwise a run reports 512 addresses scanned on a /24 somebody listed twice, and the
    // summary D-08 persists is wrong for ever.
    assert.equal(size('10.0.0.0/24, 10.0.0.0/24'), 254);
    assert.equal(size('10.0.0.1-10, 10.0.0.5-20'), 20);
  });

  it('joins adjacent runs', () => {
    assert.equal(parseIpRange('10.0.0.1-10, 10.0.0.11-20').spans.length, 1);
  });

  it('keeps genuinely separate runs separate', () => {
    assert.equal(parseIpRange('10.0.0.1-10, 10.0.0.20-30').spans.length, 2);
  });
});

describe('addressAt — what makes a sweep resumable', () => {
  it('indexes across spans, so progress is one integer', () => {
    // A run's position is how many addresses have been offered, which survives a probe restart,
    // a reconnect and a core failover — where an iterator survives none of them.
    const range = parseIpRange('10.0.0.1-10.0.0.2, 192.168.0.5-192.168.0.6');
    assert.equal(toText(addressAt(range, 0) ?? 0), '10.0.0.1');
    assert.equal(toText(addressAt(range, 1) ?? 0), '10.0.0.2');
    assert.equal(toText(addressAt(range, 2) ?? 0), '192.168.0.5');
    assert.equal(toText(addressAt(range, 3) ?? 0), '192.168.0.6');
    assert.equal(addressAt(range, 4), null, 'past the end is the end');
    assert.equal(addressAt(range, -1), null);
  });

  it('resumes from the middle and produces the rest exactly once', () => {
    const range = parseIpRange('10.0.0.0/29');
    const rest: string[] = [];
    for (let at = 3; ; at += 1) {
      const value = addressAt(range, at);
      if (value === null) break;
      rest.push(toText(value));
    }
    assert.deepEqual(rest, ['10.0.0.4', '10.0.0.5', '10.0.0.6']);
  });
});

describe('conversion', () => {
  it('round-trips', () => {
    for (const address of ['0.0.0.0', '10.0.0.1', '172.16.254.3', '255.255.255.255']) {
      assert.equal(toText(toNumber(address)), address);
    }
  });

  it('keeps the top octet unsigned', () => {
    // `255.x.x.x` is where a signed 32-bit shift shows up, and it shows up as a negative
    // address that sorts before everything else.
    assert.ok(toNumber('255.255.255.255') > 0);
    assert.equal(toNumber('255.255.255.255'), 4_294_967_295);
  });

  it('says whether an address is in the range', () => {
    const range = parseIpRange('10.0.0.0/24');
    assert.equal(contains(range, toNumber('10.0.0.5')), true);
    assert.equal(contains(range, toNumber('10.0.0.0')), false, 'the network address is excluded');
    assert.equal(contains(range, toNumber('10.0.1.5')), false);
  });

  it('bounds a run at the documented maximum', () => {
    assert.equal(MAX_ADDRESSES, 65_536);
  });
});
