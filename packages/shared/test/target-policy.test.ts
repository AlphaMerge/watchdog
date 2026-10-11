import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  exceptionProblem,
  excepts,
  isLinkLocal,
  isMetadataAddress,
  isMetadataService,
  isPrivate,
  refusedAddresses,
  refuses,
  unmapped,
} from '../src/net/target-policy.js';

/**
 * What the target policy reads an address as (`A-54`).
 *
 * The guard checks addresses, so an address it reads wrongly is a hole whatever else it does.
 * Two were open: an IPv4 address inside an IPv4-mapped IPv6 one, which a socket connects to as
 * the IPv4 address, and the one metadata address that is not link-local.
 */

/** 169.254.169.254, every way an IPv4-mapped IPv6 address can spell it. */
const MAPPED_METADATA = [
  '::ffff:169.254.169.254',
  '::ffff:a9fe:a9fe',
  '::FFFF:A9FE:A9FE',
  '0:0:0:0:0:ffff:a9fe:a9fe',
  '0000:0000:0000:0000:0000:ffff:169.254.169.254',
  '::ffff:a9fe:a9fe%eth0',
];

describe('an IPv4-mapped IPv6 address', () => {
  it('is read as the IPv4 address it carries, however it is spelt', () => {
    for (const address of MAPPED_METADATA) {
      assert.equal(unmapped(address), '169.254.169.254', address);
    }
    assert.equal(unmapped('::ffff:10.0.0.1'), '10.0.0.1');
    assert.equal(unmapped('::ffff:a00:1'), '10.0.0.1');
    assert.equal(unmapped('::ffff:0:0'), '0.0.0.0');
    assert.equal(unmapped('::ffff:ffff:ffff'), '255.255.255.255');
  });

  it('and nothing else is changed', () => {
    for (const address of [
      '169.254.169.254',
      '8.8.8.8',
      '::1',
      'fe80::1',
      '2001:db8::a9fe:a9fe',
      // Other prefixes that end in the same 32 bits, and are other addresses.
      '::ffff:0:a9fe:a9fe',
      '::a9fe:a9fe',
      '1::ffff:a9fe:a9fe',
      '0:0:0:0:1:ffff:a9fe:a9fe',
      'not-an-address',
      '',
    ]) {
      assert.equal(unmapped(address), address, address);
    }
  });

  it('is link-local when the address inside it is', () => {
    for (const address of MAPPED_METADATA) {
      assert.equal(isLinkLocal(address), true, address);
      assert.match(refuses('link-local', address) ?? '', /link-local/, address);
      assert.match(refuses('private', address) ?? '', /link-local/, address);
      assert.equal(refuses('none', address), null, address);
    }
    assert.equal(isLinkLocal('::ffff:169.253.255.255'), false);
    assert.equal(isLinkLocal('::ffff:a9ff:1'), false);
    assert.equal(refuses('link-local', '::ffff:10.0.0.1'), null);
    assert.equal(refuses('link-local', '::ffff:7f00:1'), null);
  });

  it('is private when the address inside it is, in the hexadecimal spelling too', () => {
    assert.equal(isPrivate('::ffff:10.0.0.1'), true);
    assert.equal(isPrivate('::ffff:a00:1'), true);
    assert.equal(isPrivate('::ffff:7f00:1'), true);
    assert.equal(isPrivate('::ffff:c0a8:101'), true);
    assert.equal(isPrivate('::ffff:808:808'), false);
    assert.match(refuses('private', '::ffff:a00:1') ?? '', /private/);
  });

  it('is multicast when the address inside it is, under every policy', () => {
    assert.match(refuses('none', '::ffff:239.0.0.1') ?? '', /multicast/);
    assert.match(refuses('none', '::ffff:ef00:1') ?? '', /multicast/);
  });
});

describe('link-local, read from the address and not its spelling', () => {
  it('is fe80::/10, whole', () => {
    for (const address of [
      'fe80::1',
      'FE80::1',
      'febf:ffff::1',
      'fe80:0:0:0:0:0:0:1',
      'fe80::1%eth0',
    ]) {
      assert.equal(isLinkLocal(address), true, address);
    }
    for (const address of ['fec0::1', 'fe7f::1', 'fd00::1', '::1', '2001:db8::fe80']) {
      assert.equal(isLinkLocal(address), false, address);
    }
  });

  it('is 169.254.0.0/16', () => {
    assert.equal(isLinkLocal('169.254.0.0'), true);
    assert.equal(isLinkLocal('169.254.255.255'), true);
    assert.equal(isLinkLocal('169.253.0.1'), false);
    assert.equal(isLinkLocal('170.254.0.1'), false);
  });
});

describe('a metadata address that is not link-local', () => {
  const SPELLINGS = [
    'fd00:ec2::254',
    'FD00:EC2::254',
    'fd00:0ec2:0:0:0:0:0:254',
    'fd00:ec2:0::0:254',
  ];

  it('is refused under the default policy, however it is spelt', () => {
    for (const address of SPELLINGS) {
      assert.equal(isLinkLocal(address), false, address);
      assert.equal(isMetadataAddress(address), true, address);
      assert.match(refuses('link-local', address) ?? '', /instance-metadata/, address);
      assert.ok(refuses('private', address) !== null, address);
      assert.equal(refuses('none', address), null, address);
    }
  });

  it('and its neighbours are not: the rest of unique-local is somebody’s network', () => {
    for (const address of [
      'fd00:ec2::255',
      'fd00:ec2::1:254',
      'fd00:ec3::254',
      'fd00::254',
      'fc00:ec2::254',
    ]) {
      assert.equal(isMetadataAddress(address), false, address);
      assert.equal(refuses('link-local', address), null, address);
      assert.match(refuses('private', address) ?? '', /private/, address);
    }
  });

  it('Alibaba Cloud’s, inside carrier-grade NAT, is refused under the default as well (A-79)', () => {
    // `private` always refused it, as carrier-grade NAT; `link-local`, the default, did not.
    for (const address of ['100.100.100.200', '::ffff:100.100.100.200', '::ffff:6464:64c8']) {
      assert.equal(isLinkLocal(address), false, address);
      assert.equal(isMetadataAddress(address), true, address);
      assert.match(refuses('link-local', address) ?? '', /instance-metadata/, address);
      assert.match(refuses('private', address) ?? '', /instance-metadata/, address);
      assert.equal(refuses('none', address), null, address);
    }
    // The rest of the range is somebody’s network: an ISP's, or a tailnet's.
    for (const address of ['100.100.100.100', '100.100.100.201', '100.100.101.200', '100.64.0.1']) {
      assert.equal(isMetadataAddress(address), false, address);
      assert.equal(refuses('link-local', address), null, address);
      assert.match(refuses('private', address) ?? '', /private/, address);
    }
  });

  it('every link-local address is one', () => {
    assert.equal(isMetadataAddress('169.254.169.254'), true);
    assert.equal(isMetadataAddress('fe80::1'), true);
    assert.equal(isMetadataAddress('::ffff:a9fe:a9fe'), true);
    assert.equal(isMetadataAddress('10.0.0.1'), false);
    assert.equal(isMetadataAddress('not-an-address'), false);
  });

  it('is found among a name’s other addresses', () => {
    const refused = refusedAddresses('link-local', [
      '93.184.216.34',
      '::ffff:a9fe:a9fe',
      '2001:db8::1',
      'fd00:ec2::254',
    ]);
    assert.deepEqual(
      refused.map((one) => one.address),
      ['::ffff:a9fe:a9fe', 'fd00:ec2::254'],
    );
  });
});

/**
 * One device's exception to the policy (`A-64`): the addresses it names, matched as addresses.
 */
describe('a device’s exception', () => {
  it('takes an address of either family, and nothing else', () => {
    for (const entry of ['169.254.10.5', 'fe80::1', '10.0.0.1', '::1', '2001:db8::7']) {
      assert.equal(exceptionProblem(entry), null, entry);
    }
    const refused: [string, RegExp][] = [
      ['169.254.10.0/24', /a range/],
      ['fe80::/10', /a range/],
      ['fe80::1%eth0', /zone/],
      ['device.example', /not an IPv4 or IPv6 address/],
      ['', /not an IPv4 or IPv6 address/],
      ['169.254.10', /not an IPv4 or IPv6 address/],
      ['224.0.0.1', /multicast/],
      ['255.255.255.255', /multicast/],
      ['ff02::1', /multicast/],
      ['0.0.0.0', /unspecified/],
      ['::', /unspecified/],
      ['::ffff:0.0.0.0', /unspecified/],
    ];
    for (const [entry, why] of refused) assert.match(exceptionProblem(entry) ?? '', why, entry);
  });

  it('never names a metadata service, however it is spelt', () => {
    for (const entry of [
      '169.254.169.254',
      ...MAPPED_METADATA.filter((one) => !one.includes('%')),
      '169.254.170.2',
      '::ffff:169.254.170.2',
      'fd00:ec2::254',
      'FD00:0EC2:0:0:0:0:0:254',
      '100.100.100.200',
      '::ffff:6464:64c8',
    ]) {
      assert.match(exceptionProblem(entry) ?? '', /instance-metadata service/, entry);
      assert.equal(isMetadataService(entry), true, entry);
    }
    // The rest of the range, and the provider's other services in it, are ordinary devices.
    for (const entry of [
      '169.254.169.253',
      '169.254.169.123',
      '169.254.170.3',
      'fe80::a9fe',
      '100.100.100.201',
    ]) {
      assert.equal(exceptionProblem(entry), null, entry);
      assert.equal(isMetadataService(entry), false, entry);
    }
  });

  it('lets through the address it names and no other, in any spelling', () => {
    const exception = ['169.254.10.5', 'fe80::1'];
    const table: [string, boolean][] = [
      ['169.254.10.5', true],
      ['::ffff:169.254.10.5', true],
      ['::ffff:a9fe:a05', true],
      ['fe80::1', true],
      ['FE80:0:0:0:0:0:0:1', true],
      // A zone names a link, and another link's fe80::1 is another machine: never excepted,
      // since an entry cannot say which link it meant.
      ['fe80::1%eth0', false],
      ['fe80::1%eth1', false],
      ['fe80::1%2', false],
      ['169.254.10.5%eth0', false],
      ['169.254.10.6', false],
      ['169.254.10.50', false],
      ['fe80::2', false],
      ['10.0.0.1', false],
      ['device.example', false],
      ['', false],
    ];
    for (const [address, allowed] of table) {
      assert.equal(excepts(exception, address), allowed, address);
    }
    assert.equal(excepts(undefined, '169.254.10.5'), false);
    assert.equal(excepts([], '169.254.10.5'), false);
  });

  it('never lets through what no exception reaches, whatever the list says', () => {
    // The list comes from the core, and the probe holds this line itself.
    const listed = [
      '169.254.169.254',
      '::ffff:a9fe:a9fe',
      'fd00:ec2::254',
      '169.254.170.2',
      '100.100.100.200',
      '224.0.0.1',
      '0.0.0.0',
      '169.254.10.0/24',
      'fe80::1%eth0',
    ];
    for (const address of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      'fd00:ec2::254',
      '169.254.170.2',
      '100.100.100.200',
      '224.0.0.1',
      '0.0.0.0',
      '169.254.10.5',
      'fe80::1',
    ]) {
      assert.equal(excepts(listed, address), false, address);
    }
  });
});
