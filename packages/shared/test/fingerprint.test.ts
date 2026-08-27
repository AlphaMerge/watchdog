import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  classify,
  enterpriseOf,
  IDENTIFY_PORTS,
  type DeviceKind,
  type Evidence,
  type OpenPort,
} from '../src/net/fingerprint.js';

/**
 * What a host looks like, from what was collected (`D-02`).
 *
 * **This is where a wrong answer is expensive and invisible.** A misclassified host gets the
 * wrong sensor set from `D-03`, every one of those sensors fails from its first scan, and an
 * operator concludes that discovery does not work. It is also the only part of identification
 * that can be tested without a network, so the whole classifier is pure and every case below is
 * a string a real device actually sends.
 */

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  address: '10.0.0.5',
  ports: [],
  ...over,
});

const ports = (...list: number[]): OpenPort[] =>
  list.map((port) => ({ port, transport: 'tcp' as const }));

const kindOf = (over: Partial<Evidence>): DeviceKind => classify(evidence(over)).kind;

describe('sysObjectID — a vendor saying what its own product is', () => {
  it('reads the enterprise number out of the prefix', () => {
    assert.deepEqual(enterpriseOf('1.3.6.1.4.1.9.1.1745'), { id: 9, rest: '1.1745' });
    assert.deepEqual(enterpriseOf('.1.3.6.1.4.1.2636.1.1.1.2.29'), {
      id: 2636,
      rest: '1.1.1.2.29',
    });
    assert.deepEqual(enterpriseOf('1.3.6.1.4.1.8072'), { id: 8072, rest: '' });
  });

  it('refuses an OID that is not under the enterprise arc', () => {
    // Everything after the enterprise number is the vendor's own business, which is exactly why
    // this reads the number and stops rather than trying to parse further.
    assert.equal(enterpriseOf('1.3.6.1.2.1.1.1.0'), null);
    assert.equal(enterpriseOf('nonsense'), null);
    assert.equal(enterpriseOf(undefined), null);
  });

  it('classifies from the vendor where the number is enough', () => {
    const cisco = classify(evidence({ sysObjectId: '1.3.6.1.4.1.9.1.1745' }));
    assert.equal(cisco.kind, 'network');
    assert.equal(cisco.vendor, 'Cisco');
    assert.ok(cisco.confidence >= 80);
    assert.equal(kindOf({ sysObjectId: '1.3.6.1.4.1.6876.4.1' }), 'hypervisor');
    assert.equal(kindOf({ sysObjectId: '1.3.6.1.4.1.311.1.1.3.1.1' }), 'windows');
    assert.equal(kindOf({ sysObjectId: '1.3.6.1.4.1.2435.2.3.9.1' }), 'printer');
  });

  it('still learns something from an enterprise it does not recognise', () => {
    // A host with an enterprise sysObjectID is managed equipment, and on a network that is
    // overwhelmingly a switch or an appliance rather than a general-purpose host. Low
    // confidence, but not nothing — and the note says which number it was, so an operator can
    // look it up.
    const found = classify(evidence({ sysObjectId: '1.3.6.1.4.1.99999.1.2' }));
    assert.equal(found.kind, 'network');
    assert.ok(found.confidence < 60);
    assert.match(found.evidence.join(' '), /enterprise 99999/);
  });
});

describe('sysDescr — prose, but the vendor’s own', () => {
  // Every one of these is a string a real device sends.
  const cases: [string, DeviceKind][] = [
    ['VMware ESXi 8.0.2 build-23305546 VMware, Inc. x86_64', 'hypervisor'],
    ['Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E3', 'network'],
    ['Juniper Networks, Inc. ex2200-24t-4g Ethernet Switch, kernel JUNOS 12.3R12-S15', 'network'],
    ['FortiGate-60F v7.2.5,build1517,230606 (GA.F)', 'network'],
    ['RouterOS CHR', 'network'],
    [
      'Hardware: Intel64 Family 6 - Software: Windows Version 6.3 (Build 17763 Multiprocessor Free)',
      'windows',
    ],
    ['Linux fileserver 5.15.0-91-generic #101-Ubuntu SMP x86_64', 'linux'],
    ['Synology DiskStation DS920+', 'nas'],
    ['NetApp Release 9.12.1P4: Tue Jul 11 04:41:53 UTC 2023', 'nas'],
    ['HP ETHERNET MULTI-ENVIRONMENT,SN:CNBRK1234,FN:JetDirect', 'printer'],
    ['FreeBSD firewall.example.com 13.2-RELEASE-p5 amd64', 'linux'],
  ];

  for (const [descr, expected] of cases) {
    it(`reads "${descr.slice(0, 44)}…" as ${expected}`, () => {
      assert.equal(kindOf({ sysDescr: descr }), expected);
    });
  }

  it('reads ESXi as a hypervisor rather than as the Linux it half looks like', () => {
    // The reason the rules are ordered most-specific-first. An ESXi host's agent reports a
    // Linux-looking string, and rules ordered the other way round would classify every
    // hypervisor in the estate as a Linux server — which is the wrong sensor set for it.
    const found = classify(
      evidence({ sysDescr: 'VMware ESXi 8.0.2 build-23305546 VMware, Inc. x86_64 linux' }),
    );
    assert.equal(found.kind, 'hypervisor');
  });

  it('names the vendor where the string does', () => {
    assert.equal(classify(evidence({ sysDescr: 'Cisco IOS Software' })).vendor, 'Cisco');
    assert.equal(classify(evidence({ sysDescr: 'Synology DiskStation' })).vendor, 'Synology');
  });
});

describe('ports — a guess, and treated as one', () => {
  it('reads a printer from JetDirect', () => {
    // Almost nothing but a printer listens on 9100, and one that also serves IPP is not in
    // doubt.
    assert.equal(kindOf({ ports: ports(9100) }), 'printer');
    assert.ok(classify(evidence({ ports: ports(9100, 631) })).confidence > 70);
  });

  it('reads Windows from RDP or WinRM', () => {
    assert.equal(kindOf({ ports: ports(3389) }), 'windows');
    assert.equal(kindOf({ ports: ports(5985) }), 'windows');
  });

  it('does not read SMB *and* SSH as Windows', () => {
    // A Linux box running Samba, which is common enough that reading it as Windows would create
    // a WMI sensor set on a machine with no WMI at all.
    assert.equal(kindOf({ ports: ports(445, 22) }), 'linux');
    assert.equal(kindOf({ ports: ports(445) }), 'windows');
  });

  it('never outranks a vendor string', () => {
    // A switch with a web interface on 443 and SSH on 22 is still a switch.
    assert.equal(
      kindOf({ sysDescr: 'Cisco IOS Software, Version 15.2', ports: ports(22, 443) }),
      'network',
    );
  });

  it('asks about a bounded set of ports, each with a reason', () => {
    assert.ok(IDENTIFY_PORTS.length <= 16, 'a sweep is not a port scanner');
    for (const one of IDENTIFY_PORTS) assert.ok(one.why.length > 5, String(one.port));
  });
});

describe('the SSH banner', () => {
  it('reads a Windows OpenSSH banner as Windows', () => {
    const found = classify(
      evidence({
        ports: [{ port: 22, transport: 'tcp', banner: 'SSH-2.0-OpenSSH_for_Windows_8.1' }],
      }),
    );
    assert.equal(found.kind, 'windows');
  });

  it('reads any other banner as a Unix-like host', () => {
    assert.equal(
      kindOf({ ports: [{ port: 22, transport: 'tcp', banner: 'SSH-2.0-OpenSSH_9.2p1 Debian-2' }] }),
      'linux',
    );
  });
});

describe('reverse DNS — the weakest evidence and the most useful thing to show', () => {
  it('raises a classification nothing better decided', () => {
    assert.equal(kindOf({ reverseName: 'sw-core-01.example.com' }), 'network');
    assert.equal(kindOf({ reverseName: 'printer3.office.example.com' }), 'printer');
    assert.equal(kindOf({ reverseName: 'esxi-02.dc.example.com' }), 'hypervisor');
  });

  it('never outranks a vendor string', () => {
    // Somebody typed the name years ago; the vendor wrote sysDescr this morning.
    assert.equal(
      kindOf({ sysDescr: 'Linux backup 5.15.0 x86_64', reverseName: 'sw-old-name.example.com' }),
      'linux',
    );
  });

  it('does not match a name that merely contains the letters', () => {
    // `swan`, `answers`, `gwen` — a substring match here would classify half an estate as
    // switches.
    assert.equal(kindOf({ reverseName: 'swan.example.com' }), 'unknown');
    assert.equal(kindOf({ reverseName: 'gwendolyn.example.com' }), 'unknown');
  });

  it('is reported whether or not it classified anything', () => {
    const found = classify(evidence({ reverseName: 'mystery.example.com' }));
    assert.equal(found.reverseName, 'mystery.example.com');
    assert.match(found.evidence.join(' '), /mystery\.example\.com/);
  });
});

describe('unknown is a real answer', () => {
  it('says so rather than guessing', () => {
    // A host that answered a ping and nothing else exists, and a Ping sensor is the right thing
    // to create for it. Guessing would create sensors that fail from their first scan, which is
    // how an operator learns to distrust discovery.
    const found = classify(evidence());
    assert.equal(found.kind, 'unknown');
    assert.equal(found.confidence, 0);
    assert.match(found.evidence.join(' '), /nothing identified this host/);
  });

  it('keeps every fact it collected, whatever it concluded', () => {
    // Absent means *not known*, never *not present*: a host that did not answer SNMP and a host
    // with no SNMP agent are different facts, and a template treating them alike would create
    // SNMP sensors on machines that have none.
    const found = classify(
      evidence({ ports: ports(80), httpServer: 'nginx/1.24.0', sysName: 'thing' }),
    );
    assert.equal(found.httpServer, 'nginx/1.24.0');
    assert.equal(found.sysName, 'thing');
    assert.deepEqual(found.ports, ports(80));
    assert.equal(found.sysDescr, undefined, 'and does not invent what it did not learn');
  });
});

describe('confidence', () => {
  it('rises with the quality of the evidence, not its quantity', () => {
    const guessed = classify(evidence({ ports: ports(22) }));
    const told = classify(evidence({ sysDescr: 'Linux host 5.15.0 x86_64' }));
    assert.ok(
      told.confidence > guessed.confidence,
      `${String(told.confidence)} > ${String(guessed.confidence)}`,
    );
  });

  it('says why, in words an operator who disagrees can read', () => {
    const found = classify(
      evidence({
        sysObjectId: '1.3.6.1.4.1.9.1.1745',
        sysDescr: 'Cisco IOS Software, Version 15.2(7)E3',
        ports: ports(22, 443),
        reverseName: 'sw-access-04.example.com',
      }),
    );
    assert.ok(found.evidence.length >= 3, found.evidence.join(' | '));
    assert.match(found.evidence.join(' '), /Cisco/);
  });
});
