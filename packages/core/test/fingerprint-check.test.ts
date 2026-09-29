import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { classify, type BuildStamp, type Evidence } from '@ms/shared';
import { ApiServer } from '../src/api/server.js';
import {
  BUILT_IN_DEVICE_TEMPLATES,
  DeviceTemplateCatalogue,
} from '../src/device-templates/index.js';
import { checkFingerprint } from '../src/discovery/fingerprint.js';
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
