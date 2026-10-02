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
  UNKNOWN_FIELD_MAX_LENGTH,
  UNKNOWN_FIELD_NAME_MAX_LENGTH,
  UNKNOWN_FIELDS_MAX,
  UNKNOWN_PORT_FIELDS_MAX,
  vendorBreakdown,
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

  it('keeps a field it does not know when it is a word, a number or a flag', () => {
    // A newer probe's field, carried into the jsonb column for a later release to read.
    const check = checkFingerprint({ ...valid, model: 'X99', rackUnits: 2, virtual: false });
    assert.ok(check.ok);
    const kept = check.fingerprint as unknown as Record<string, unknown>;
    assert.equal(kept['model'], 'X99');
    assert.equal(kept['rackUnits'], 2);
    assert.equal(kept['virtual'], false);
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

  describe('a field this build does not know (A-73)', () => {
    // `identify-progress` leaves a fingerprint's fields open so a newer probe's are stored for
    // a later release to read. Until this they were carried at any size and any depth.
    const KNOWN = ['address', 'kind', 'confidence', 'ports', 'evidence'];
    const unknown = (kept: Record<string, unknown>): string[] =>
      Object.keys(kept).filter((key) => !KNOWN.includes(key));

    const DROPPED: readonly (readonly [string, unknown])[] = [
      ['an object', { model: 'X99' }],
      ['an empty object', {}],
      ['an array', ['a', 'b']],
      ['an array of megabytes', ['x'.repeat(1_000_000)]],
      ['null', null],
      ['infinity, which JSON cannot say', Number.POSITIVE_INFINITY],
      ['not a number', Number.NaN],
      ['text that cleans to nothing', ' \u0000\n '],
    ];
    for (const [what, value] of DROPPED) {
      it(`drops ${what}`, () => {
        const kept = read({ ...valid, somethingNewer: value, model: 'X99' });
        assert.deepEqual(unknown(kept), ['model'], 'and keeps the field beside it');
      });
    }

    const KEPT: readonly (readonly [string, unknown, unknown])[] = [
      ['a word', 'X99', 'X99'],
      ['zero', 0, 0],
      ['a negative fraction', -1.5, -1.5],
      ['true', true, true],
      ['false', false, false],
      ['text of several lines, as one', 'a\r\nb\u2028c', 'a b c'],
      ['text at the limit', 'u'.repeat(UNKNOWN_FIELD_MAX_LENGTH), 'u'.repeat(500)],
      ['text past it, cut', 'u'.repeat(50_000), 'u'.repeat(500)],
    ];
    for (const [what, value, expected] of KEPT) {
      it(`keeps ${what}`, () => {
        assert.deepEqual(read({ ...valid, somethingNewer: value })['somethingNewer'], expected);
      });
    }

    it('keeps the first sixteen and drops the rest, counting only what it keeps', () => {
      assert.equal(UNKNOWN_FIELDS_MAX, 16);
      const many: Record<string, unknown> = {};
      for (let n = 0; n < 40; n += 1) {
        // Every third is something that is dropped anyway, and does not use up a place.
        many[`f${String(n).padStart(2, '0')}`] = n % 3 === 0 ? { nested: n } : n;
      }
      const kept = unknown(read({ ...valid, ...many }));
      assert.equal(kept.length, 16);
      assert.deepEqual(kept.slice(0, 4), ['f01', 'f02', 'f04', 'f05']);
      // And the fields it knows are not counted against them.
      const full = read({ ...valid, ...many, vendor: 'Acme', sysName: 'sw-01' });
      assert.equal(full['vendor'], 'Acme');
      assert.equal(full['sysName'], 'sw-01');
      assert.equal(unknown(full).length, 18);
    });

    it('drops a field whose name is not one short line', () => {
      assert.equal(UNKNOWN_FIELD_NAME_MAX_LENGTH, 64);
      const kept = read({
        ...valid,
        ['n'.repeat(64)]: 1,
        ['n'.repeat(65)]: 2,
        ['m'.repeat(1_000_000)]: 3,
        'two\nlines': 4,
        ' padded': 5,
        '': 6,
      });
      assert.deepEqual(unknown(kept), ['n'.repeat(64)]);
    });

    it('bounds what a megabyte of unknown fields is stored as', () => {
      const flood: Record<string, unknown> = {};
      for (let n = 0; n < 2_000; n += 1) flood[`field${String(n)}`] = 'x'.repeat(10_000);
      flood['deep'] = { a: { b: { c: 'x'.repeat(1_000_000) } } };
      const stored = JSON.stringify(read({ ...valid, ...flood }));
      assert.ok(stored.length < 10_000, `${String(stored.length)} characters were kept`);
    });

    it('holds a port to the same rule: eight fields, and a transport that is a word', () => {
      assert.equal(UNKNOWN_PORT_FIELDS_MAX, 8);
      const extra: Record<string, unknown> = {};
      for (let n = 0; n < 20; n += 1) extra[`p${String(n).padStart(2, '0')}`] = `v${String(n)}`;
      const kept = read({
        ...valid,
        ports: [
          { port: 22, transport: 'tcp', banner: 'SSH-2.0', tls: true, ...extra },
          { port: 161, transport: 'u'.repeat(5_000), detail: { community: 'x'.repeat(100_000) } },
          { port: 443, transport: 7, long: 'y'.repeat(50_000) },
        ],
      })['ports'] as Record<string, unknown>[];
      const [ssh, snmp, https] = kept;
      assert.ok(ssh !== undefined && snmp !== undefined && https !== undefined);
      assert.equal(ssh['port'], 22);
      assert.equal(ssh['transport'], 'tcp');
      assert.equal(ssh['banner'], 'SSH-2.0');
      assert.equal(ssh['tls'], true);
      assert.equal(
        Object.keys(ssh).filter((key) => !['port', 'transport', 'banner'].includes(key)).length,
        8,
      );
      assert.deepEqual(snmp, { port: 161, transport: 'u'.repeat(16) });
      assert.deepEqual(https, { port: 443, long: 'y'.repeat(500) });
    });

    it('reads what it kept as it kept it, so a stored row reads as it was stored', () => {
      const flood: Record<string, unknown> = { model: 'X\nY', units: 2, nested: { a: 1 } };
      for (let n = 0; n < 40; n += 1) flood[`f${String(n)}`] = `value ${String(n)}`;
      const once = read({ ...valid, ...flood, ports: [{ port: 22, transport: 'tcp', x: 'y' }] });
      assert.deepEqual(read(JSON.parse(JSON.stringify(once))), once);
    });
  });

  describe('the summary’s vendor breakdown (A-73)', () => {
    it('shows each vendor as the check keeps one, whatever the row says', () => {
      assert.deepEqual(
        vendorBreakdown([
          { vendor: 'Acme', count: 3 },
          { vendor: `Big\r\nCorp ${'v'.repeat(5_000)}`, count: 2 },
        ]),
        [
          { vendor: 'Acme', count: 3 },
          {
            vendor: `Big Corp ${'v'.repeat(FINGERPRINT_TEXT_LIMITS.vendor - 9)}`,
            count: 2,
          },
        ],
      );
    });

    it('counts together rows that are the same vendor once cleaned, and puts the most first', () => {
      assert.deepEqual(
        vendorBreakdown([
          { vendor: 'Zyx', count: 4 },
          { vendor: 'Acme', count: 3 },
          { vendor: 'Acme\u0000', count: 2 },
          { vendor: ' Acme ', count: 1 },
          { vendor: 'Bolt', count: 4 },
        ]),
        [
          { vendor: 'Acme', count: 6 },
          // One count: in the order the rows came, which is the database's.
          { vendor: 'Zyx', count: 4 },
          { vendor: 'Bolt', count: 4 },
        ],
      );
    });

    it('leaves out a vendor that cleans to nothing, as an absent one is', () => {
      assert.deepEqual(
        vendorBreakdown([
          { vendor: ' \u0000\n', count: 9 },
          { vendor: '', count: 1 },
        ]),
        [],
      );
    });
  });

  it('cleans and cuts with one function, the one a refusal goes through', () => {
    assert.equal(boundedText('a\nb', 10), 'a b');
    assert.equal(boundedText('abcdef', 3), 'abc');
    assert.equal(boundedText(' \u0000 ', 3), undefined);
    assert.equal(boundedText(['a'], 3), undefined);
    // Never half a character: jsonb refuses a lone surrogate, and one refused field fails the
    // batch it came in. A pair that straddles the cut goes whole; one that arrived alone is
    // replaced. What is kept can always be stored.
    const pair = '\u{1f600}';
    assert.equal(boundedText(`ab${pair}`, 3), 'ab');
    assert.equal(boundedText(`ab${pair}`, 4), `ab${pair}`);
    assert.equal(boundedText(`a\ud83d b`, 10), 'a\ufffd b');
    assert.equal(boundedText(`a\ude00b`, 10), 'a\ufffdb');
    for (const text of [`ab${pair}`, `${pair}${pair}`, '\ud83d', '\ude00\ud83d', `x\ud83d`]) {
      for (let max = 1; max <= 5; max += 1) {
        const kept = boundedText(text, max) ?? '';
        assert.ok(kept.length <= max, `${JSON.stringify(text)} at ${String(max)}`);
        assert.equal(
          /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(kept),
          false,
          `${JSON.stringify(text)} at ${String(max)}`,
        );
      }
    }
    assert.equal(refusalText('r'.repeat(600)), 'r'.repeat(500));
  });
});
