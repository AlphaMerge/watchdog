import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { classify, type BuildStamp, type Evidence } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import {
  BUILT_IN_DEVICE_TEMPLATES,
  DeviceTemplateCatalogue,
} from '../src/device-templates/index.js';
import {
  BANNER_MAX_LENGTH,
  boundedText,
  checkFingerprint,
  EVIDENCE_ITEM_MAX_LENGTH,
  EVIDENCE_MAX_ITEMS,
  FINGERPRINT_TEXT_LIMITS,
  PORTS_MAX_ITEMS,
  REFUSAL_MAX_LENGTH,
  refusalText,
} from '../src/discovery/fingerprint.js';
import { baseOptions } from './support/surface.js';

/**
 * Checking a fingerprint (`D-12`).
 *
 * One check, for a fingerprint a probe reported and for one an operator submits to the plan
 * route. Until `D-12` the route had none: its body schema takes any object, the matcher read
 * `ports.map` on whatever arrived, and `{}` answered 500. Nothing caught it because the one test
 * that sent `{}` ran against a catalogue with no templates, so nothing was ever matched.
 */

const valid = {
  address: '10.0.0.5',
  kind: 'linux',
  ports: [{ port: 22, transport: 'tcp' }],
  confidence: 45,
  evidence: ['SSH is open'],
};

/** The shipped templates: the ones whose criteria read `ports`, `vendor` and `sysObjectId`. */
const builtIn = (): DeviceTemplateCatalogue => {
  const held = new DeviceTemplateCatalogue(() => true);
  for (const template of BUILT_IN_DEVICE_TEMPLATES) held.register(template, 'built-in');
  return held.seal();
};

describe('checking a fingerprint (D-12)', () => {
  // Each of these reaches something downstream that throws on it, or writes a row the database
  // refuses, except the kind, which `D-03` has no sensor set for.
  const REFUSED: readonly (readonly [string, unknown, string])[] = [
    ['nothing at all', {}, 'address'],
    ['an address that is not IPv4', { ...valid, address: '10.0.0.300' }, 'address'],
    ['a kind this build does not know', { ...valid, kind: 'quantum-toaster' }, 'kind'],
    ['a vendor that is a number', { ...valid, vendor: 5 }, 'vendor'],
    ['a sysObjectId that is an object', { ...valid, sysObjectId: { oid: '1.3.6' } }, 'sysObjectId'],
    ['a sysDescr that is a list', { ...valid, sysDescr: ['Linux'] }, 'sysDescr'],
    ['a sysName that is a number', { ...valid, sysName: 7 }, 'sysName'],
    ['a reverseName that is a boolean', { ...valid, reverseName: true }, 'reverseName'],
    ['an httpServer that is a number', { ...valid, httpServer: 2 }, 'httpServer'],
    ['a refusal that is not a sentence', { ...valid, refused: true }, 'refused'],
    ['ports that are not a list', { ...valid, ports: '22' }, 'ports'],
    ['a port that is nothing', { ...valid, ports: [null] }, 'ports[0].port'],
    [
      'a port with no number',
      { ...valid, ports: [{ port: 22 }, { transport: 'tcp' }] },
      'ports[1].port',
    ],
    ['a port number written as text', { ...valid, ports: [{ port: '22' }] }, 'ports[0].port'],
    ['a port past 65535', { ...valid, ports: [{ port: 70_000 }] }, 'ports[0].port'],
    ['a fractional port', { ...valid, ports: [{ port: 22.5 }] }, 'ports[0].port'],
    ['port zero', { ...valid, ports: [{ port: 0 }] }, 'ports[0].port'],
  ];
  for (const [what, value, field] of REFUSED) {
    it(`refuses ${what}, naming ${field}`, () => {
      const check = checkFingerprint(value);
      assert.ok(!check.ok);
      assert.equal(check.field, field);
    });
  }

  it('refuses a value that is not an object', () => {
    for (const value of [null, undefined, 'text', 5, [valid]]) {
      assert.equal(checkFingerprint(value).ok, false, JSON.stringify(value));
    }
  });

  it('takes what the classifier produces, unchanged', () => {
    // What a probe actually sends. A check that refused it would drop every fingerprint a run
    // recorded, and the run would provision nothing but ping sensors.
    const evidence: Evidence[] = [
      { address: '10.0.0.5', ports: [] },
      {
        address: '10.0.0.6',
        ports: [{ port: 22, transport: 'tcp', banner: 'SSH-2.0-OpenSSH_9.6' }],
        reverseName: 'db1.example.',
      },
      {
        address: '10.0.0.7',
        ports: [{ port: 443, transport: 'tcp' }],
        sysDescr: 'Cisco IOS Software, C2960 Software',
        sysObjectId: '1.3.6.1.4.1.9.1.1208',
        sysName: 'core-sw',
        httpServer: 'cisco-IOS',
      },
    ];
    for (const one of evidence) {
      const fingerprint = classify(one);
      assert.deepEqual(checkFingerprint(fingerprint), { ok: true, fingerprint });
    }
  });

  it('reads null in a text field or in ports as absent, and removes it', () => {
    // Removed, not kept: provisioning asks `vendor !== undefined` before it reads one.
    const check = checkFingerprint({ ...valid, vendor: null, sysDescr: null, ports: null });
    assert.ok(check.ok);
    assert.equal('vendor' in check.fingerprint, false);
    assert.equal('sysDescr' in check.fingerprint, false);
    assert.deepEqual(check.fingerprint.ports, []);
  });

  it('needs only an address and a kind', () => {
    const check = checkFingerprint({ address: '10.0.0.5', kind: 'unknown' });
    assert.ok(check.ok);
    assert.deepEqual(check.fingerprint, {
      address: '10.0.0.5',
      kind: 'unknown',
      confidence: 0,
      ports: [],
      evidence: [],
    });
  });

  it('keeps a field it does not know, even a null one', () => {
    // A newer probe's field, carried into the jsonb column for a later release to read.
    const check = checkFingerprint({ ...valid, somethingNewer: { model: 'X99' }, later: null });
    assert.ok(check.ok);
    const kept = check.fingerprint as unknown as Record<string, unknown>;
    assert.deepEqual(kept['somethingNewer'], { model: 'X99' });
    assert.equal(kept['later'], null);
  });

  it('clamps a confidence and keeps only the evidence that is text', () => {
    // Neither can break a match, so neither is a reason to refuse a fingerprint.
    const confidence = (value: unknown): number | null => {
      const check = checkFingerprint({ ...valid, confidence: value });
      return check.ok ? check.fingerprint.confidence : null;
    };
    assert.equal(confidence(250), 100);
    assert.equal(confidence(-3), 0);
    assert.equal(confidence('high'), 0);
    const check = checkFingerprint({ ...valid, evidence: ['a', 5, null, 'b'] });
    assert.ok(check.ok);
    assert.deepEqual(check.fingerprint.evidence, ['a', 'b']);
  });

  it('hands the shipped templates nothing they cannot read', () => {
    // The other half of the contract: whatever the check lets through, the matcher and the
    // planner finish on, with every credential kind available so every spec is considered.
    const templates = builtIn();
    const credentials = new Set(['snmp', 'ssh', 'http', 'mail', 'database', 'windows']);
    const accepted = [
      { address: '10.0.0.5', kind: 'network' },
      { ...valid, vendor: null, sysObjectId: null, ports: null },
      { ...valid, kind: 'printer', vendor: 'HP', sysObjectId: '.1.3.6.1.4.1.11.2.3.9.1' },
      { ...valid, kind: 'windows', ports: [{ port: 5985 }, { port: 445, transport: 'tcp' }] },
    ];
    for (const value of accepted) {
      const check = checkFingerprint(value);
      assert.ok(check.ok, JSON.stringify(value));
      assert.ok(templates.plan(check.fingerprint, credentials).templates.length > 0);
    }
  });
});

describe('the plan route (D-12)', () => {
  let server: ApiServer;

  before(async () => {
    // No database: planning is pure, and authentication is off so the handler is reached.
    const stamp: BuildStamp = {
      version: '0.0.0-dev',
      commit: null,
      dirty: false,
      profile: 'v1',
      lock: null,
    };
    const base = baseOptions(stamp, false);
    server = new ApiServer({ ...base, deviceTemplates: builtIn() });
    await server.build(stamp.version, base.service);
    await server.app.ready();
  });

  after(async () => {
    await server.app.close();
  });

  const plan = (fingerprint: unknown) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/device-templates/plan',
      payload: { fingerprint },
    });

  it('answers 400 naming the field, where it answered 500', async () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [{}, 'fingerprint.address'],
      [{ ...valid, vendor: 5 }, 'fingerprint.vendor'],
      [{ ...valid, ports: [null] }, 'fingerprint.ports[0].port'],
    ];
    for (const [fingerprint, field] of cases) {
      const response = await plan(fingerprint);
      assert.equal(response.statusCode, 400, `${field}: ${response.body}`);
      const { error } = response.json<{
        error: { code: string; message: string; context: { field?: string } };
      }>();
      assert.equal(error.code, 'FINGERPRINT_INVALID');
      assert.equal(error.context.field, field);
      assert.ok(error.message.startsWith(`${field} `), error.message);
    }
  });

  it('plans a fingerprint it can read, a null text field included', async () => {
    for (const fingerprint of [valid, { ...valid, vendor: null }]) {
      const response = await plan(fingerprint);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json<{ templates: { id: string }[]; sensors: unknown[] }>();
      assert.ok(body.templates.length > 0);
      assert.ok(body.sensors.length > 0);
    }
  });
});

describe('a refusal is a probe’s word, and is checked like one (A-63)', () => {
  const bare = { address: '10.0.0.5', kind: 'unknown', ports: [], confidence: 0, evidence: [] };
  const why = 'not identified: refusing to identify 10.0.0.5, which is a private address';
  const read = (value: unknown) => {
    const check = checkFingerprint(value);
    assert.ok(check.ok);
    return check.fingerprint;
  };

  it('believes a refusal of a host nothing was found on', () => {
    const fingerprint = read({ ...bare, refused: why, evidence: [why] });
    assert.equal(fingerprint.refused, why);
    assert.equal(fingerprint.refusalIgnored, undefined);
  });

  // Each of these is something a source found, and a host with any is not one nothing was
  // asked of.
  const FINDINGS: readonly (readonly [string, Record<string, unknown>])[] = [
    ['a kind', { kind: 'linux' }],
    ['an open port', { ports: [{ port: 22, transport: 'tcp' }] }],
    ['a reverse name', { reverseName: 'gw.example.com' }],
    ['a sysDescr', { sysDescr: 'Linux 6.1' }],
    ['a sysObjectId', { sysObjectId: '1.3.6.1.4.1.9.1.1' }],
    ['a sysName', { sysName: 'sw-01' }],
    ['an HTTP server', { httpServer: 'nginx' }],
    ['a vendor', { vendor: 'Cisco' }],
  ];
  for (const [what, finding] of FINDINGS) {
    it(`sets a refusal aside when the fingerprint also carries ${what}`, () => {
      const fingerprint = read({ ...bare, ...finding, refused: why });
      assert.equal(fingerprint.refused, undefined, 'the host is counted by what was found');
      assert.equal(fingerprint.refusalIgnored, why, 'and the claim is kept to be shown');
      // And the findings are as they arrived.
      for (const [key, value] of Object.entries(finding)) {
        assert.deepEqual((fingerprint as unknown as Record<string, unknown>)[key], value);
      }
    });
  }

  it('does not read confidence, evidence or an empty field as a finding', () => {
    const fingerprint = read({
      ...bare,
      confidence: 90,
      evidence: ['SSH is open'],
      sysDescr: '  ',
      vendor: '',
      refused: why,
    });
    assert.equal(fingerprint.refused, why);
    assert.equal(fingerprint.refusalIgnored, undefined);
  });

  it('gives the same answer when what it stored is read again', () => {
    for (const value of [
      { ...bare, refused: why },
      { ...bare, kind: 'linux', refused: why },
      { ...bare, kind: 'linux' },
    ]) {
      const once = read(value);
      assert.deepEqual(read(JSON.parse(JSON.stringify(once))), once);
    }
  });

  it('keeps a claim set aside only where there are findings for it to be about', () => {
    assert.equal(read({ ...bare, refusalIgnored: why }).refusalIgnored, undefined);
    assert.equal(read({ ...bare, refusalIgnored: why }).refused, undefined);
    assert.equal(read({ ...bare, kind: 'nas', refusalIgnored: `${why}\n` }).refusalIgnored, why);
    // What the probe says now outranks what it is said to have said.
    assert.equal(
      read({ ...bare, kind: 'nas', refused: 'now', refusalIgnored: 'then' }).refusalIgnored,
      'now',
    );
  });

  it('makes a refusal one line: control characters and line breaks become a space', () => {
    const forged = 'refused\r\n10.0.0.9 — all sensors deleted\u0000\u001b[31m\u2028next\u0085\ttab';
    const fingerprint = read({ ...bare, refused: forged });
    assert.equal(fingerprint.refused, 'refused 10.0.0.9 — all sensors deleted [31m next tab');
    // eslint-disable-next-line no-control-regex -- that there are none is the assertion.
    assert.doesNotMatch(fingerprint.refused ?? '', /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    // The same on a claim set aside.
    assert.equal(read({ ...bare, kind: 'nas', refused: 'a\nb' }).refusalIgnored, 'a b');
  });

  it('cuts a refusal at its bound', () => {
    assert.equal(REFUSAL_MAX_LENGTH, 500);
    const fingerprint = read({ ...bare, refused: 'x'.repeat(100_000) });
    assert.equal(fingerprint.refused, 'x'.repeat(500));
    assert.equal(
      read({ ...bare, kind: 'nas', refused: 'y'.repeat(501) }).refusalIgnored,
      'y'.repeat(500),
    );
    assert.equal(refusalText('z'.repeat(500)), 'z'.repeat(500), 'and no shorter');
  });

  it('reads a refusal that says nothing as no refusal', () => {
    for (const empty of ['', '   ', '\n\t\u0000']) {
      const fingerprint = read({ ...bare, refused: empty });
      assert.equal('refused' in fingerprint, false, JSON.stringify(empty));
    }
    assert.equal(refusalText(null), undefined);
    assert.equal(refusalText(7), undefined);
  });
});

/**
 * Every free-text field is a remote probe's word, and is kept bounded and on one line (`A-69`).
 *
 * `A-63` bounded `refused` and left the rest: our probe cuts what it collects, and a probe that
 * is not ours need not. They reach a device's name and its comments, the plan an operator is
 * shown, and the log.
 */
describe('a fingerprint’s text is bounded where it is checked (A-69)', () => {
  const read = (value: unknown): Record<string, unknown> => {
    const check = checkFingerprint(value);
    assert.ok(check.ok);
    return check.fingerprint as unknown as Record<string, unknown>;
  };
  // eslint-disable-next-line no-control-regex -- that there are none is the assertion.
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

  /** The field, its limit, and why a correct probe never passes it. */
  const LIMITS: readonly (readonly [keyof typeof FINGERPRINT_TEXT_LIMITS, number])[] = [
    ['reverseName', 255],
    ['sysDescr', 1_000],
    ['sysObjectId', 256],
    ['sysName', 255],
    ['httpServer', 200],
    ['vendor', 100],
  ];

  it('has a limit for every text field a source fills, and these are the numbers', () => {
    assert.deepEqual(Object.fromEntries(LIMITS), FINGERPRINT_TEXT_LIMITS);
    assert.equal(BANNER_MAX_LENGTH, 200);
    assert.equal(EVIDENCE_MAX_ITEMS, 32);
    assert.equal(EVIDENCE_ITEM_MAX_LENGTH, 500);
    assert.equal(PORTS_MAX_ITEMS, 64);
  });

  for (const [field, max] of LIMITS) {
    it(`cuts ${field} at ${String(max)} characters, and no shorter`, () => {
      assert.equal(read({ ...valid, [field]: 'x'.repeat(100_000) })[field], 'x'.repeat(max));
      assert.equal(read({ ...valid, [field]: 'y'.repeat(max + 1) })[field], 'y'.repeat(max));
      assert.equal(read({ ...valid, [field]: 'z'.repeat(max) })[field], 'z'.repeat(max));
    });

    it(`makes ${field} one line: control characters and line breaks become a space`, () => {
      const forged = `first\r\nsecond\u0000\u001b[31m\u2028third\u0085\ttab  end`;
      const kept = read({ ...valid, [field]: forged })[field];
      assert.equal(kept, 'first second [31m third tab end');
      assert.doesNotMatch(kept, CONTROL);
    });

    it(`reads a ${field} that says nothing as absent`, () => {
      for (const empty of ['', '   ', '\n\t\u0000']) {
        assert.equal(field in read({ ...valid, [field]: empty }), false, JSON.stringify(empty));
      }
    });
  }

  it('cuts a banner, makes it one line, and drops one that is not text or says nothing', () => {
    const ports = read({
      ...valid,
      ports: [
        { port: 22, transport: 'tcp', banner: 'b'.repeat(5_000) },
        { port: 25, transport: 'tcp', banner: '220 mail\r\n250 forged\u0007' },
        { port: 80, transport: 'tcp', banner: { toString: 'no' } },
        { port: 443, transport: 'tcp', banner: ' \n ' },
        { port: 8080, transport: 'tcp', banner: null, later: 'kept' },
        { port: 21, transport: 'tcp', banner: 'c'.repeat(200) },
      ],
    })['ports'];
    assert.deepEqual(ports, [
      { port: 22, transport: 'tcp', banner: 'b'.repeat(200) },
      { port: 25, transport: 'tcp', banner: '220 mail 250 forged' },
      { port: 80, transport: 'tcp' },
      { port: 443, transport: 'tcp' },
      { port: 8080, transport: 'tcp', later: 'kept' },
      { port: 21, transport: 'tcp', banner: 'c'.repeat(200) },
    ]);
  });

  it('keeps the first 64 ports and the first 32 evidence notes', () => {
    const many = Array.from({ length: 300 }, (_, at) => ({ port: at + 1, transport: 'tcp' }));
    const notes = Array.from({ length: 300 }, (_, at) => `note ${String(at)}`);
    const kept = read({ ...valid, ports: many, evidence: notes });
    assert.deepEqual(kept['ports'], many.slice(0, 64));
    assert.deepEqual(kept['evidence'], notes.slice(0, 32));
    // And exactly that many are kept as they are.
    const exact = read({ ...valid, ports: many.slice(0, 64), evidence: notes.slice(0, 32) });
    assert.equal((exact['ports'] as unknown[]).length, 64);
    assert.equal((exact['evidence'] as unknown[]).length, 32);
  });

  it('cuts an evidence note at 500, makes it one line, and counts only the notes that say something', () => {
    const kept = read({
      ...valid,
      evidence: ['e'.repeat(9_000), 'a\nforged line\u0001', '', ' \t ', 5, null, 'f'.repeat(500)],
    })['evidence'];
    assert.deepEqual(kept, ['e'.repeat(500), 'a forged line', 'f'.repeat(500)]);
    // Thirty-two that say something, however many before them say nothing.
    const padded = [
      ...Array.from({ length: 40 }, () => ' '),
      ...Array.from({ length: 40 }, () => 'n'),
    ];
    assert.equal((read({ ...valid, evidence: padded })['evidence'] as unknown[]).length, 32);
  });

  it('still refuses a port past the sixty-fourth that is not a port', () => {
    // Bounded, not unread: the whole list is checked before any of it is dropped.
    const many: unknown[] = Array.from({ length: 70 }, (_, at) => ({ port: at + 1 }));
    many[69] = { port: 'ssh' };
    const check = checkFingerprint({ ...valid, ports: many });
    assert.deepEqual(check, {
      ok: false,
      field: 'ports[69].port',
      problem: 'must be an integer from 1 to 65535',
    });
  });

  it('counts a host by what is kept: a field of control characters is not a finding', () => {
    const why = 'refusing to identify 10.0.0.5';
    const fingerprint = read({
      address: '10.0.0.5',
      kind: 'unknown',
      sysName: '\u0000\u0001',
      vendor: '\n',
      refused: why,
    });
    assert.equal(fingerprint['refused'], why);
    assert.equal('refusalIgnored' in fingerprint, false);
    assert.equal('sysName' in fingerprint, false);
  });

  it('gives the same answer when what it kept is read again, so a stored row reads as it was stored', () => {
    const once = read({
      ...valid,
      sysDescr: `Cisco IOS\r\n${'d'.repeat(5_000)}`,
      sysName: 'n'.repeat(999),
      vendor: 'Acme\u0000',
      ports: [{ port: 22, transport: 'tcp', banner: 'SSH-2.0\r\nX' }],
      evidence: ['one\ntwo', 'e'.repeat(700)],
    });
    assert.deepEqual(read(JSON.parse(JSON.stringify(once))), once);
  });

  it('carries a field it does not know at any length: the frame is the bound on it', () => {
    // Written down, not fixed here: `identify-progress` leaves a fingerprint's fields open so a
    // newer probe's are stored for a later release to read.
    const long = 'u'.repeat(50_000);
    assert.equal(read({ ...valid, somethingNewer: long })['somethingNewer'], long);
  });

  it('cleans and cuts with one function, the one a refusal goes through', () => {
    assert.equal(boundedText('a\nb', 10), 'a b');
    assert.equal(boundedText('abcdef', 3), 'abc');
    assert.equal(boundedText(' \u0000 ', 3), undefined);
    assert.equal(boundedText(['a'], 3), undefined);
    assert.equal(refusalText('r'.repeat(600)), 'r'.repeat(500));
  });
});
