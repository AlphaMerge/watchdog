import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pino } from 'pino';
import { classify, type Evidence, type Fingerprint } from '@ms/shared';
import { sensorTypesFor, standardCatalogue, withheldReason } from '@ms/sensors';
import {
  applicableSensors,
  BUILT_IN_DEVICE_TEMPLATES,
  DeviceTemplateCatalogue,
  matchScore,
  matchTemplates,
  loadDeviceTemplates,
  templateFromDevice,
  validateTemplate,
  type DeviceTemplate,
} from '../src/device-templates/index.js';
import { checkFingerprint } from '../src/discovery/fingerprint.js';

/**
 * Device templates (`D-03`).
 *
 * **Matching is where a mistake is expensive and silent.** A template that matches too widely
 * puts SNMP sensors on a printer with no agent; every one of them fails from its first scan, and
 * an operator concludes discovery does not work. So all of it is pure and all of it is tested
 * against fingerprints built by the real classifier rather than by hand — otherwise these would
 * assert that two files agree with each other rather than that either is right.
 */

const catalogue = standardCatalogue();
const known = (id: string): boolean => catalogue.has(id);

const fingerprint = (over: Partial<Evidence> = {}): Fingerprint =>
  classify({ address: '10.0.0.5', ports: [], ...over });

const ports = (...list: number[]) => list.map((port) => ({ port, transport: 'tcp' as const }));

/** The same validator the core wires in, so these assert what an installation actually gets. */
const validateParams = (id: string, params: Readonly<Record<string, unknown>>): string[] => {
  const outcome = catalogue.validate(id, params);
  return outcome.valid ? [] : outcome.problems.map((one) => one.message);
};

const built = (): DeviceTemplateCatalogue => {
  const held = new DeviceTemplateCatalogue(known, validateParams);
  for (const template of BUILT_IN_DEVICE_TEMPLATES) held.register(template, 'built-in');
  return held.seal();
};

describe('matching', () => {
  it('ANDs every criterion that is present', () => {
    // A template that ORed its criteria would widen as it was made more specific, which is the
    // opposite of what anybody writing one expects.
    const match = { kind: ['linux' as const], portsAll: [22] };
    assert.notEqual(
      matchScore(fingerprint({ ports: ports(22), sysDescr: 'Linux host' }), match),
      null,
    );
    assert.equal(matchScore(fingerprint({ sysDescr: 'Linux host' }), match), null, 'no port 22');
    // SSH open, so `portsAll` is satisfied — and RDP too, so the classifier says Windows.
    // (SMB *and* SSH would not do: the classifier reads that pair as a Linux box running Samba.)
    assert.equal(matchScore(fingerprint({ ports: ports(22, 3389) }), match), null, 'not linux');
  });

  it('matches everything when there are no criteria, and scores zero', () => {
    // What makes the generic fallback safe: there is always at least a Ping sensor, so a device
    // nothing recognised is still monitored rather than created bare.
    assert.equal(matchScore(fingerprint(), {}), 0);
  });

  it('scores by how specific a criterion is, not by how many there are', () => {
    const cisco = fingerprint({
      sysObjectId: '1.3.6.1.4.1.9.1.1745',
      sysDescr: 'Cisco IOS Software, Version 15.2',
      ports: ports(22, 443),
    });
    const byOid = matchScore(cisco, { sysObjectIdPrefix: ['1.3.6.1.4.1.9'] }) ?? 0;
    const byPorts = matchScore(cisco, { portsAll: [22, 443] }) ?? 0;
    assert.ok(byOid > byPorts, `${String(byOid)} should beat ${String(byPorts)}`);
  });

  it('matches an OID prefix on component boundaries', () => {
    // `startsWith` would make Cisco's arc — enterprise 9 — match enterprise 99, 900 and 9999,
    // which are entirely unrelated vendors. The same class of mistake as a substring match on a
    // hostname, and just as invisible once a template has been written against it.
    //
    // The direction matters: a *longer* OID under a shorter prefix is caught either way, so the
    // assertion that earns its place is a longer prefix against a shorter, unrelated arc. A
    // mutation run found this test asserting it the wrong way round and passing regardless.
    const cisco = fingerprint({ sysObjectId: '1.3.6.1.4.1.9.1.1745' });
    assert.notEqual(matchScore(cisco, { sysObjectIdPrefix: ['1.3.6.1.4.1.9'] }), null);
    assert.equal(matchScore(cisco, { sysObjectIdPrefix: ['1.3.6.1.4.1.99'] }), null);

    const other = fingerprint({ sysObjectId: '1.3.6.1.4.1.99.1.2' });
    assert.equal(
      matchScore(other, { sysObjectIdPrefix: ['1.3.6.1.4.1.9'] }),
      null,
      'enterprise 99 is not under enterprise 9',
    );
    assert.notEqual(matchScore(other, { sysObjectIdPrefix: ['1.3.6.1.4.1.99'] }), null);
    assert.notEqual(
      matchScore(fingerprint({ sysObjectId: '.1.3.6.1.4.1.9' }), {
        sysObjectIdPrefix: ['1.3.6.1.4.1.9.'],
      }),
      null,
      'a leading or trailing dot on either side is the same OID',
    );
  });

  it('compares a vendor case-insensitively and refuses a device with none', () => {
    const synology = fingerprint({ sysDescr: 'Synology DiskStation DS920+' });
    assert.notEqual(matchScore(synology, { vendor: ['SYNOLOGY'] }), null);
    assert.equal(matchScore(fingerprint(), { vendor: ['Synology'] }), null);
  });

  it('reads portsAll as every one and portsAny as at least one', () => {
    const web = fingerprint({ ports: ports(80) });
    assert.notEqual(matchScore(web, { portsAny: [80, 443] }), null);
    assert.equal(matchScore(web, { portsAll: [80, 443] }), null);
  });

  it('does not let a stateful regex change its own answer', () => {
    // A cached `RegExp` with the `g` flag carries `lastIndex` between calls, so the same
    // fingerprint would match or not depending on what was tested before it.
    const linux = fingerprint({ sysDescr: 'Linux host 5.15 x86_64' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.notEqual(matchScore(linux, { sysDescr: 'linux' }), null, String(attempt));
    }
  });

  it('returns every template that applies, most specific first', () => {
    // A device is genuinely several things at once: a Linux box serving HTTP wants both sets,
    // and picking one would mean somebody writing "Linux server that also serves HTTP".
    const host = fingerprint({ sysDescr: 'Linux web01 5.15 x86_64', ports: ports(22, 80, 443) });
    const matched = matchTemplates(host, [...BUILT_IN_DEVICE_TEMPLATES]);
    const ids = matched.map((one) => one.template.id);
    assert.ok(ids.includes('ms.linux'), ids.join(', '));
    assert.ok(ids.includes('ms.web-server'), ids.join(', '));
    assert.ok(ids.includes('ms.generic'), 'the fallback always applies');
    assert.equal(ids.at(-1), 'ms.generic', 'and is always last, because it knows nothing');
  });

  it('breaks a tie by id, so two runs produce the same order', () => {
    const one: DeviceTemplate = {
      id: 'z.one',
      name: 'Z',
      description: '',
      match: {},
      sensors: [{ type: 'icmp.ping' }],
    };
    const two: DeviceTemplate = {
      id: 'a.two',
      name: 'A',
      description: '',
      match: {},
      sensors: [{ type: 'icmp.ping' }],
    };
    assert.deepEqual(
      matchTemplates(fingerprint(), [one, two]).map((m) => m.template.id),
      ['a.two', 'z.one'],
    );
  });
});

describe('which sensors a template actually creates', () => {
  const linux = BUILT_IN_DEVICE_TEMPLATES.find((one) => one.id === 'ms.linux');

  it('leaves out a sensor whose port is closed', () => {
    // "Linux server" is a reasonable thing to match, and an SSH Disk Free sensor on a Linux
    // server with SSH firewalled off is a sensor that fails for ever.
    assert.ok(linux !== undefined);
    const noSsh = fingerprint({ sysDescr: 'Linux host 5.15' });
    const specs = applicableSensors(linux, noSsh, new Set(['ssh', 'snmp']));
    assert.ok(
      !specs.some((one) => one.type.startsWith('ssh.')),
      specs.map((s) => s.type).join(', '),
    );
  });

  it('leaves out a sensor whose credential nothing can supply', () => {
    // Twelve SNMP sensors on a device whose group has no SNMP credential is twelve sensors that
    // fail from their first scan, which is how an operator learns to distrust discovery.
    assert.ok(linux !== undefined);
    const host = fingerprint({ sysDescr: 'Linux host 5.15', ports: ports(22) });
    const withNothing = applicableSensors(linux, host, new Set());
    assert.deepEqual(
      withNothing.map((one) => one.type),
      ['icmp.ping'],
    );

    const withSsh = applicableSensors(linux, host, new Set(['ssh']));
    assert.ok(withSsh.some((one) => one.type === 'ssh.load'));
    assert.ok(!withSsh.some((one) => one.type.startsWith('snmp.')), 'and still no SNMP');
  });

  it('only creates the SNMP set when SNMP actually answered', () => {
    // A fingerprint has a sysDescr exactly when an agent replied, which is what the specs use
    // to say "only if SNMP is really there".
    assert.ok(linux !== undefined);
    const noAgent = fingerprint({ ports: ports(22), reverseName: 'host.example.com' });
    // Force the kind so the template still matches without an agent.
    const asLinux: Fingerprint = { ...noAgent, kind: 'linux' };
    const specs = applicableSensors(linux, asLinux, new Set(['ssh', 'snmp']));
    assert.ok(
      !specs.some((one) => one.type.startsWith('snmp.')),
      specs.map((s) => s.type).join(', '),
    );
  });
});

describe('the plan for a device', () => {
  it('deduplicates by type and parameters, not by type alone', () => {
    // Two templates naming `icmp.ping` mean one Ping sensor; two naming `http.request` on
    // different paths mean two.
    const held = built();
    const host = fingerprint({ sysDescr: 'Linux web01 5.15', ports: ports(22, 80, 443) });
    const plan = held.plan(host, new Set(['ssh', 'snmp']));
    const pings = plan.sensors.filter((one) => one.type === 'icmp.ping');
    assert.equal(pings.length, 1, 'one Ping across three matching templates');
    assert.ok(plan.sensors.some((one) => one.type === 'tls.certificate'));
  });

  it('treats two specs differing only in key order as one', () => {
    // JSON.stringify preserves insertion order, and two templates written by two people will
    // not agree on it — so without a stable key this would be two sensors on every device.
    const held = new DeviceTemplateCatalogue(known);
    held.register(
      {
        id: 'a.one',
        name: 'A',
        description: '',
        match: {},
        sensors: [{ type: 'http.request', params: { scheme: 'http', port: 80 } }],
      },
      'test',
    );
    held.register(
      {
        id: 'b.two',
        name: 'B',
        description: '',
        match: {},
        sensors: [{ type: 'http.request', params: { port: 80, scheme: 'http' } }],
      },
      'test',
    );
    assert.equal(held.seal().plan(fingerprint()).sensors.length, 1);
  });

  it('lets the most specific template win a tie on the same key', () => {
    const held = new DeviceTemplateCatalogue(known);
    held.register(
      {
        id: 'a.generic',
        name: 'Generic',
        description: '',
        match: {},
        sensors: [{ type: 'snmp.cpu', name: 'Generic CPU' }],
      },
      'test',
    );
    held.register(
      {
        id: 'b.cisco',
        name: 'Cisco',
        description: '',
        match: { sysObjectIdPrefix: ['1.3.6.1.4.1.9'] },
        sensors: [{ type: 'snmp.cpu', name: 'Cisco CPU' }],
      },
      'test',
    );
    const plan = held.seal().plan(fingerprint({ sysObjectId: '1.3.6.1.4.1.9.1.1' }));
    assert.equal(plan.sensors[0]?.name, 'Cisco CPU');
    assert.equal(plan.sensors.length, 1);
  });

  it('collects the tags of every template that applied', () => {
    const held = built();
    const plan = held.plan(fingerprint({ sysDescr: 'Linux web01 5.15', ports: ports(80) }));
    assert.ok(plan.tags.includes('auto-discovered'));
    assert.ok(plan.tags.includes('linux'));
    assert.ok(plan.tags.includes('web'));
  });

  it('always plans something, even for a host nothing recognised', () => {
    const plan = built().plan(fingerprint());
    assert.deepEqual(
      plan.sensors.map((one) => one.type),
      ['icmp.ping'],
    );
  });
});

describe('the built-in set', () => {
  const held = built();

  it('loads with no problems', () => {
    // The assertion is that every type they name exists, every one is configured well enough to
    // actually be created, and no template is malformed. The second of those was added after
    // provisioning failed on a built-in: `snmp.diskfree` was named without the mount point it
    // requires, so every device got a Ping and nothing else while the report said nothing was
    // wrong.
    assert.deepEqual(held.problems(), []);
    assert.equal(held.all().length, BUILT_IN_DEVICE_TEMPLATES.length);
  });

  it('names only sensor types this build ships', () => {
    for (const template of BUILT_IN_DEVICE_TEMPLATES) {
      for (const spec of template.sensors) {
        assert.ok(catalogue.has(spec.type), `${template.id} names ${spec.type}`);
      }
    }
  });

  it('marks at most one master per template, and it is the reachability sensor', () => {
    // `ms.web-server` has none on purpose: it is *additive* — matched alongside whatever the
    // device really is — so it names the sensors a web server wants and leaves the device's
    // identity to the template that knows it.
    for (const template of BUILT_IN_DEVICE_TEMPLATES) {
      const masters = template.sensors.filter((one) => one.master === true);
      assert.ok(masters.length <= 1, `${template.id} marks ${String(masters.length)}`);
      if (masters[0] !== undefined) assert.equal(masters[0].type, 'icmp.ping', template.id);
    }
  });

  it('plans exactly one master for every device, whatever it turned out to be', () => {
    // **The invariant that matters**, and it is about the plan rather than any one template:
    // `ms.generic` matches everything and marks its Ping, so a device nothing else recognised
    // still gets a master — one unreachable host is one alarm rather than a device's worth
    // (`D-05`, `WORKFLOW.MD §2`).
    const held = built();
    const cases: Partial<Evidence>[] = [
      {},
      { sysDescr: 'Linux web01 5.15', ports: ports(22, 80, 443) },
      { sysDescr: 'Windows Version 6.3', ports: ports(3389, 5985) },
      { sysObjectId: '1.3.6.1.4.1.9.1.1745', sysDescr: 'Cisco IOS Software' },
      { sysDescr: 'Synology DiskStation DS920+', ports: ports(443) },
      { ports: ports(9100, 631) },
      { sysDescr: 'VMware ESXi 8.0.2', ports: ports(443) },
    ];
    for (const one of cases) {
      const plan = held.plan(fingerprint(one), new Set(['snmp', 'ssh', 'windows']));
      const masters = plan.sensors.filter((spec) => spec.master === true);
      assert.equal(masters.length, 1, `${JSON.stringify(one)} planned ${String(masters.length)}`);
    }
  });

  it('declares a credential for every sensor that cannot work without one', () => {
    // The rule this enforces: a template must not create a sensor that will fail from its first
    // scan because nothing can authenticate it.
    for (const template of BUILT_IN_DEVICE_TEMPLATES) {
      for (const spec of template.sensors) {
        const needed = catalogue.declaration(spec.type).credentialKinds ?? [];
        if (needed.length === 0) continue;
        assert.ok(
          spec.credential !== undefined,
          `${template.id} creates ${spec.type}, which needs ${needed.join('/')}`,
        );
        assert.ok(
          needed.includes(spec.credential),
          `${template.id}: ${spec.type} wants ${spec.credential}`,
        );
      }
    }
  });

  it('plans a host the target policy refused as a host nothing identified: a Ping and nothing that connects (A-69)', () => {
    // A refused host answered the sweep and was asked nothing (`A-63`), so it is provisioned as
    // any host nothing identified is: a device and its Ping, which the policy leaves alone
    // (`A-57`). Every credential kind is available here, so nothing is left out for want of one.
    const why =
      'not identified: refusing to identify 169.254.169.254, which is link-local, under the ' +
      'probe’s target policy “link-local”';
    const refused = checkFingerprint({
      address: '169.254.169.254',
      ports: [],
      kind: 'unknown',
      confidence: 0,
      evidence: [why],
      refused: why,
    });
    assert.ok(refused.ok);
    assert.equal(refused.fingerprint.refused, why);
    const every = new Set(['snmp', 'ssh', 'windows', 'http', 'mail', 'database']);
    const plan = held.plan(refused.fingerprint, every);
    assert.deepEqual(
      plan.templates.map((one) => one.template.id),
      ['ms.generic'],
    );
    assert.deepEqual(
      plan.sensors.map((one) => one.type),
      ['icmp.ping'],
    );
    // The same plan as a host with no fingerprint at all, which is what the rule rests on.
    assert.deepEqual(held.plan(fingerprint(), every).sensors, plan.sensors);
  });

  it('gives a Windows device its WMI set only where WinRM answered', () => {
    // T-09 needs a Windows-hosted probe. On a Linux-only installation this is never, which is
    // the honest outcome rather than three sensors failing for ever.
    const windows = fingerprint({ ports: ports(3389), sysDescr: 'Windows Version 6.3' });
    const plan = held.plan(windows, new Set(['windows']));
    assert.deepEqual(
      plan.sensors.map((one) => one.type),
      ['icmp.ping'],
    );

    const reachable = fingerprint({ ports: ports(3389, 5985), sysDescr: 'Windows Version 6.3' });
    const better = held.plan(reachable, new Set(['windows']));
    assert.ok(better.sensors.some((one) => one.type === 'windows.cpu'));
  });

  it('counts, in its description, the WMI set a Linux-only installation never creates', () => {
    // "Rather than four failing sensors" came from `D-03` and was carried into `U-92`'s rewrite,
    // for a set of three: the ping is the fourth sensor, and nothing about WinRM fails it. Held to
    // the set, so a sensor added to it or taken out says the sentence is wrong too.
    const windows = BUILT_IN_DEVICE_TEMPLATES.find((one) => one.id === 'ms.windows');
    assert.ok(windows !== undefined);
    const gated = windows.sensors.filter(
      (one) => one.requires?.portsAny?.includes(5985) === true && one.type.startsWith('windows.'),
    );
    const said = ['no', 'one', 'two', 'three', 'four', 'five', 'six'][gated.length];
    assert.match(windows.description, new RegExp(`\\b${String(said)} failing sensors\\b`, 'u'));
    assert.equal(windows.sensors.length, gated.length + 1, 'the WMI set and the ping');
  });
});

describe('refusing a bad template', () => {
  it('refuses a spec whose parameters would not make that sensor', () => {
    // Checking only that the type exists is checking half of it: the create call then fails at
    // provisioning time, once per device, long after anybody is looking at the template.
    const problems = validateTemplate(
      { id: 'a.b', name: 'X', description: '', match: {}, sensors: [{ type: 'snmp.diskfree' }] },
      known,
      validateParams,
    );
    assert.match(problems.join(' '), /cannot be created as configured/);

    assert.deepEqual(
      validateTemplate(
        {
          id: 'a.b',
          name: 'X',
          description: '',
          match: {},
          sensors: [{ type: 'snmp.diskfree', params: { mountPoint: '/' } }],
        },
        known,
        validateParams,
      ),
      [],
    );
  });

  it('names a sensor type that does not exist', () => {
    // Loudly and by name: a template naming a type that does not exist silently creates fewer
    // sensors than it says, which nobody notices until the device it mattered on goes down.
    const problems = validateTemplate(
      { id: 'a.b', name: 'X', description: '', match: {}, sensors: [{ type: 'snmp.nonsense' }] },
      known,
    );
    assert.match(problems.join(' '), /no sensor type called "snmp.nonsense"/);
  });

  it('reports every problem rather than the first', () => {
    const problems = validateTemplate(
      { id: 'NOT AN ID', name: '  ', description: '', match: {}, sensors: [] },
      known,
    );
    assert.ok(problems.length >= 3, problems.join(' | '));
  });

  it('refuses a sysDescr pattern that is not a regular expression, or is enormous', () => {
    const bad = validateTemplate(
      {
        id: 'a.b',
        name: 'X',
        description: '',
        match: { sysDescr: '([' },
        sensors: [{ type: 'icmp.ping' }],
      },
      known,
    );
    assert.match(bad.join(' '), /not a regular expression/);

    const huge = validateTemplate(
      {
        id: 'a.b',
        name: 'X',
        description: '',
        match: { sysDescr: 'x'.repeat(300) },
        sensors: [{ type: 'icmp.ping' }],
      },
      known,
    );
    assert.match(huge.join(' '), /longer than 200 characters/);
  });

  it('refuses two masters in one template', () => {
    // Which one won would depend on the order they happen to be written in, and a dependency
    // that moves when somebody reorders a file is worse than no dependency at all.
    const problems = validateTemplate(
      {
        id: 'a.b',
        name: 'X',
        description: '',
        match: {},
        sensors: [
          { type: 'icmp.ping', name: 'A', master: true },
          { type: 'snmp.uptime', name: 'B', master: true },
        ],
      },
      known,
    );
    assert.match(problems.join(' '), /at most one can be/);
  });

  it('catches a duplicated spec', () => {
    const problems = validateTemplate(
      {
        id: 'a.b',
        name: 'X',
        description: '',
        match: {},
        sensors: [{ type: 'icmp.ping' }, { type: 'icmp.ping' }],
      },
      known,
    );
    assert.match(problems.join(' '), /appears twice/);
  });

  it('keeps a refused template out of the catalogue and says why', () => {
    const held = new DeviceTemplateCatalogue(known);
    held.register(
      { id: 'a.b', name: 'X', description: '', match: {}, sensors: [{ type: 'nope' }] },
      'test',
    );
    held.seal();
    assert.equal(held.all().length, 0);
    assert.equal(held.problems().length, 1);
    assert.equal(held.problems()[0]?.source, 'test');
  });
});

describe('saving a device as a template', () => {
  const credentialKindsFor = (type: string): readonly string[] =>
    catalogue.has(type) ? (catalogue.declaration(type).credentialKinds ?? []) : [];

  it('keeps which sensor was the device’s master', () => {
    // One of the decisions the operator already made, and the whole point of saving a device as
    // a template is not having to make them again.
    const template = templateFromDevice({
      id: 'acme.switch',
      name: 'ACME switch',
      credentialKindsFor,
      sensors: [
        { name: 'Ping', sensorType: 'icmp.ping', params: {}, isMaster: true },
        { name: 'Uptime', sensorType: 'snmp.uptime', params: {} },
      ],
    });
    assert.equal(template.sensors[0]?.master, true);
    assert.equal(template.sensors[1]?.master, undefined);
  });

  it('turns a device’s sensors into specs', () => {
    const template = templateFromDevice({
      id: 'acme.switch',
      name: 'ACME switch',
      credentialKindsFor,
      sensors: [
        { name: 'Ping', sensorType: 'icmp.ping', params: { count: 4 } },
        { name: 'Uptime', sensorType: 'snmp.uptime', params: {} },
      ],
    });
    assert.equal(template.sensors.length, 2);
    assert.deepEqual(template.sensors[0], {
      type: 'icmp.ping',
      name: 'Ping',
      params: { count: 4 },
    });
    assert.equal(template.sensors[1]?.credential, 'snmp', 'and says what it needs to authenticate');
  });

  it('matches nothing until somebody says what it is for', () => {
    // Inferring a match rule from the device's own fingerprint would be wrong about half the
    // time — the operator knows whether this is for this model, this vendor or every switch,
    // and nothing in the device says which. A template that matched everything by accident
    // would put a Cisco sensor set on every printer in the estate.
    const template = templateFromDevice({
      id: 'acme.switch',
      name: 'ACME switch',
      credentialKindsFor,
      sensors: [{ name: 'Ping', sensorType: 'icmp.ping', params: {} }],
    });
    assert.equal(matchScore(fingerprint({ sysDescr: 'anything at all' }), template.match), null);
  });

  it('drops parameters nobody set', () => {
    // A saved sensor carries every default its schema has, and a template that pinned all of
    // them would stop a later release's better default from ever reaching these devices.
    const template = templateFromDevice({
      id: 'a.b',
      name: 'X',
      credentialKindsFor,
      sensors: [
        { name: 'Ping', sensorType: 'icmp.ping', params: { count: 4, host: '', tags: [] } },
      ],
    });
    assert.deepEqual(template.sensors[0]?.params, { count: 4 });
  });

  it('does not copy the same sensor twice', () => {
    const template = templateFromDevice({
      id: 'a.b',
      name: 'X',
      credentialKindsFor,
      sensors: [
        { name: 'Ping', sensorType: 'icmp.ping', params: { count: 4 } },
        { name: 'Ping', sensorType: 'icmp.ping', params: { count: 4 } },
      ],
    });
    assert.equal(template.sensors.length, 1);
  });

  it('produces a template the catalogue accepts', () => {
    const template = templateFromDevice({
      id: 'acme.switch',
      name: 'ACME switch',
      credentialKindsFor,
      match: { vendor: ['ACME'] },
      sensors: [{ name: 'Uptime', sensorType: 'snmp.uptime', params: {} }],
    });
    assert.deepEqual(validateTemplate(template, known), []);
  });
});

describe('loading an operator’s own templates', () => {
  const silent = pino({ level: 'silent' });
  let directory = '';

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'ms-templates-'));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const write = (file: string, content: unknown): void => {
    writeFileSync(
      join(directory, file),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf8',
    );
  };

  it('adds a template the operator wrote', async () => {
    write('acme.json', {
      id: 'acme.switch',
      name: 'ACME switch',
      description: 'ours',
      match: { vendor: ['ACME'] },
      sensors: [{ type: 'icmp.ping', name: 'Ping' }],
    });
    const held = await loadDeviceTemplates({ directory, logger: silent, knownSensorType: known });
    assert.ok(held.get('acme.switch') !== null);
    assert.ok(held.all().length > BUILT_IN_DEVICE_TEMPLATES.length);
  });

  it('lets a file replace a shipped template by id', async () => {
    // How an operator fixes a shipped template for the devices they actually have, without
    // waiting for a release — the same override-by-id the lookups use.
    write('override.json', {
      id: 'ms.printer',
      name: 'Our printers',
      description: 'with the toner OIDs we actually use',
      match: { kind: ['printer'] },
      sensors: [
        { type: 'icmp.ping', name: 'Ping' },
        { type: 'snmp.custom', name: 'Toner', credential: 'snmp' },
      ],
    });
    const held = await loadDeviceTemplates({ directory, logger: silent, knownSensorType: known });
    assert.equal(held.get('ms.printer')?.name, 'Our printers');
    assert.equal(held.summaries().find((one) => one.id === 'ms.printer')?.overridesBuiltIn, true);
  });

  it('takes a file holding several related templates', async () => {
    // Which is how anybody writes them: a vendor's switches, routers and firewalls belong
    // together.
    write('set.json', [
      {
        id: 'acme.router',
        name: 'R',
        description: '',
        match: {},
        sensors: [{ type: 'icmp.ping' }],
      },
      {
        id: 'acme.firewall',
        name: 'F',
        description: '',
        match: {},
        sensors: [{ type: 'icmp.ping' }],
      },
    ]);
    const held = await loadDeviceTemplates({ directory, logger: silent, knownSensorType: known });
    assert.ok(held.get('acme.router') !== null);
    assert.ok(held.get('acme.firewall') !== null);
  });

  it('refuses a bad one and keeps the rest', async () => {
    // A template that half-loaded would create some of the sensors it names and nobody would
    // notice which were missing until the day one of them mattered.
    write('bad.json', {
      id: 'acme.broken',
      name: 'Broken',
      description: '',
      match: {},
      sensors: [{ type: 'snmp.nonsense' }],
    });
    const held = await loadDeviceTemplates({ directory, logger: silent, knownSensorType: known });
    assert.equal(held.get('acme.broken'), null);
    assert.ok(held.problems().some((one) => one.id === 'acme.broken'));
    assert.ok(held.get('ms.generic') !== null, 'and the built-ins are still there');
  });

  it('reports a file that is not JSON rather than starting without it', async () => {
    write('notjson.json', '{ this is not json');
    const held = await loadDeviceTemplates({ directory, logger: silent, knownSensorType: known });
    assert.ok(held.problems().some((one) => one.source.endsWith('notjson.json')));
  });

  it('treats a missing directory as normal', async () => {
    // Most installations never write one, and a warning on every start for a directory nobody
    // needs is a warning everybody learns to ignore.
    const held = await loadDeviceTemplates({
      directory: join(directory, 'does-not-exist'),
      logger: silent,
      knownSensorType: known,
    });
    assert.deepEqual(held.problems(), []);
    assert.equal(held.all().length, BUILT_IN_DEVICE_TEMPLATES.length);
  });

  describe('in a v1 build (`H-12`)', () => {
    const v1 = standardCatalogue(sensorTypesFor('v1'));
    const options = {
      logger: silent,
      knownSensorType: (id: string): boolean => v1.has(id),
      withheld: (id: string): string | undefined => withheldReason('v1', id),
    };

    it('keeps the Windows server template, with its ping and without the WMI set', async () => {
      // Refused whole, it would take the ping with it and log an error on every v1 start.
      const held = await loadDeviceTemplates(options);
      assert.deepEqual(held.problems(), []);
      assert.deepEqual(
        held.get('ms.windows')?.sensors.map((spec) => spec.type),
        ['icmp.ping'],
      );
      assert.equal(held.all().length, BUILT_IN_DEVICE_TEMPLATES.length);
    });

    it('leaves the full build’s template whole', async () => {
      const held = await loadDeviceTemplates({ logger: silent, knownSensorType: known });
      assert.deepEqual(
        held.get('ms.windows')?.sensors.map((spec) => spec.type),
        ['icmp.ping', 'windows.cpu', 'windows.memory', 'windows.volume'],
      );
    });

    it('trims an operator’s template the same way, and still refuses a type nobody built', async () => {
      const v1Directory = mkdtempSync(join(tmpdir(), 'ms-templates-v1-'));
      try {
        writeFileSync(
          join(v1Directory, 'ours.json'),
          JSON.stringify([
            {
              id: 'acme.windows',
              name: 'Our Windows boxes',
              description: '',
              match: {},
              sensors: [{ type: 'icmp.ping' }, { type: 'windows.service' }],
            },
            {
              id: 'acme.typo',
              name: 'Typo',
              description: '',
              match: {},
              sensors: [{ type: 'icmp.ping' }, { type: 'windows.cpuu' }],
            },
          ]),
          'utf8',
        );
        const held = await loadDeviceTemplates({ ...options, directory: v1Directory });
        assert.deepEqual(
          held.get('acme.windows')?.sensors.map((spec) => spec.type),
          ['icmp.ping'],
        );
        assert.equal(held.get('acme.typo'), null);
        assert.ok(held.problems().some((one) => one.id === 'acme.typo'));
      } finally {
        rmSync(v1Directory, { recursive: true, force: true });
      }
    });
  });

  it('is sealed, so nothing can register a template after boot', async () => {
    const held = await loadDeviceTemplates({ logger: silent, knownSensorType: known });
    assert.equal(held.sealed, true);
    assert.throws(() => {
      held.register(
        { id: 'a.b', name: 'X', description: '', match: {}, sensors: [{ type: 'icmp.ping' }] },
        'late',
      );
    }, /sealed/);
  });
});
