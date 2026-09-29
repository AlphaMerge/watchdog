import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { addressKey } from '../src/auth/address-key.js';

/**
 * What a client's address counts as, to the login throttle and the rate limit (`A-47`).
 *
 * An IPv6 client is its /64, because one ordinary connection is handed a whole one; an IPv4 client
 * is its address, however it is spelt.
 */
describe('addressKey', () => {
  it('keeps an IPv4 address as it is', () => {
    assert.equal(addressKey('192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey('10.0.0.1'), '10.0.0.1');
  });

  it('counts an IPv6 address as its /64, however it is written', () => {
    const key = '2001:db8:1:2::/64';
    for (const address of [
      '2001:db8:1:2::1',
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0db8:0001:0002:0000:0000:0000:0009',
      '2001:DB8:1:2::abcd',
      '2001:db8:1:2:3:4:5:6',
      '2001:db8:1:2::1%eth0',
    ]) {
      assert.equal(addressKey(address), key, address);
    }
  });

  it('keeps different /64s apart, down to the last bit of the prefix', () => {
    assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
    assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db9:1:2::1'));
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(addressKey('::1'), '0:0:0:0::/64');
    assert.equal(addressKey('1::'), '1:0:0:0::/64');
  });

  it('counts an IPv4-mapped address as the IPv4 address, never as the /64 of ::ffff:0:0', () => {
    // How a dual-stack socket reports an IPv4 peer. Widened to its /64, every IPv4 client in the
    // world would share one key; kept apart from the dotted form, one client would count twice.
    assert.equal(addressKey('::ffff:192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey('::FFFF:192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey('::ffff:c000:207'), '192.0.2.7');
    assert.equal(addressKey('0:0:0:0:0:ffff:192.0.2.7'), '192.0.2.7');
    assert.notEqual(addressKey('::ffff:192.0.2.7'), addressKey('::ffff:192.0.2.8'));
  });

  it('keeps an address with a dotted tail that is not mapped as a /64', () => {
    assert.equal(addressKey('64:ff9b::192.0.2.7'), '64:ff9b:0:0::/64');
  });

  it('leaves what is not an address alone', () => {
    for (const text of ['', 'unknown', 'ms-proxy', '2001:db8::1::2']) {
      assert.equal(addressKey(text), text, text);
    }
  });

  it('answers a socket with no address rather than throwing', () => {
    // `request.ip` is typed as a string and is undefined for a socket already closed.
    assert.equal(addressKey(undefined), '');
  });
});
