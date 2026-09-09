import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TemplateCache, VARIABLE_LENGTH } from '../src/support/flow/index.js';

/**
 * The template cache (`B-03`).
 *
 * Every case here is a way a stateful collector produces confident wrong numbers rather than an
 * error, which is the failure mode that matters: a missing flow is visible and a mis-decoded one
 * is not.
 */
describe('the flow template cache', () => {
  const key = { exporter: '192.0.2.1', observationDomain: 0, templateId: 256 };
  const fields = [
    { id: 8, length: 4 },
    { id: 12, length: 4 },
  ];

  it('returns a template it has learnt', () => {
    const cache = new TemplateCache();
    cache.learn(key, fields);
    assert.deepEqual(cache.get(key)?.fields, fields);
  });

  it('does not know a template it has never seen', () => {
    assert.equal(new TemplateCache().get(key), undefined);
  });

  it('precomputes the record width, and leaves it unknown when a field is variable', () => {
    const cache = new TemplateCache();
    assert.equal(cache.learn(key, fields).recordBytes, 8);
    assert.equal(
      cache.learn({ ...key, templateId: 257 }, [{ id: 82, length: VARIABLE_LENGTH }]).recordBytes,
      undefined,
    );
  });

  describe('what the key has to include, and why', () => {
    it('keeps one exporter’s template 256 apart from another’s', () => {
      // **The mis-decode this prevents.** Template 256 from one switch has nothing to do with 256
      // from another; keying on the id alone reads one device's flows with another's layout and
      // produces plausible, wrong numbers instead of an error.
      const cache = new TemplateCache();
      cache.learn(key, fields);
      assert.equal(cache.get({ ...key, exporter: '198.51.100.9' }), undefined);
    });

    it('keeps one observation domain apart from another on the same exporter', () => {
      // A single device may export several domains whose template ids are independent.
      const cache = new TemplateCache();
      cache.learn(key, fields);
      assert.equal(cache.get({ ...key, observationDomain: 7 }), undefined);
    });
  });

  describe('redefinition', () => {
    it('lets the last definition win, because exporters reuse ids after a reconfiguration', () => {
      const cache = new TemplateCache();
      cache.learn(key, fields);
      const wider = [
        { id: 8, length: 4 },
        { id: 12, length: 4 },
        { id: 7, length: 2 },
      ];
      cache.learn(key, wider);
      assert.deepEqual(cache.get(key)?.fields, wider);
      assert.equal(cache.get(key)?.recordBytes, 10);
    });

    it('counts a changed definition', () => {
      const cache = new TemplateCache();
      cache.learn(key, fields);
      cache.learn(key, [{ id: 8, length: 4 }]);
      assert.equal(cache.stats().redefined, 1);
    });

    it('does not count a re-sent identical template, which is every refresh interval', () => {
      // Otherwise the statistic reports every healthy exporter as constantly reconfiguring.
      const cache = new TemplateCache();
      cache.learn(key, fields);
      cache.learn(key, [...fields]);
      cache.learn(key, [...fields]);
      assert.equal(cache.stats().redefined, 0);
    });
  });

  describe('expiry', () => {
    it('forgets a template that has gone unrefreshed, and counts it', () => {
      let now = 1_000;
      const cache = new TemplateCache({ ttlMs: 100, now: () => now });
      cache.learn(key, fields);
      now = 1_050;
      assert.ok(cache.get(key), 'still fresh');
      now = 1_200;
      assert.equal(cache.get(key), undefined);
      assert.equal(cache.stats().expired, 1);
    });

    it('ages from when the template was last seen, not when it was first learnt', () => {
      // **A live exporter's templates must never age out.** Measuring from the first sighting
      // expires them mid-conversation on any exporter whose refresh interval exceeds the TTL.
      let now = 1_000;
      const cache = new TemplateCache({ ttlMs: 100, now: () => now });
      cache.learn(key, fields);
      now = 1_080;
      cache.learn(key, fields); // refreshed
      now = 1_150;
      assert.ok(cache.get(key), 'refreshed 70 ms ago, not 150');
    });
  });

  describe('bounds', () => {
    it('evicts the oldest-seen past the ceiling, and counts it', () => {
      // **Bounded because the key is attacker-influenced**: nothing authenticates a flow
      // datagram, so anything reachable can mint templates under invented domains for ever.
      let now = 0;
      const cache = new TemplateCache({ maxTemplates: 3, now: () => now++ });
      for (let id = 256; id < 261; id += 1) cache.learn({ ...key, templateId: id }, fields);

      assert.equal(cache.stats().held, 3);
      assert.equal(cache.stats().evicted, 2);
      assert.equal(cache.get({ ...key, templateId: 256 }), undefined, 'the oldest went');
      assert.ok(cache.get({ ...key, templateId: 260 }), 'the newest stayed');
    });
  });

  it('forgets everything one exporter holds, for a reboot', () => {
    // A device that restarts may reuse ids for different layouts, and its old templates decoding
    // its new data is the silent corruption this module is arranged to avoid.
    const cache = new TemplateCache();
    cache.learn(key, fields);
    cache.learn({ ...key, templateId: 257 }, fields);
    cache.learn({ ...key, exporter: '198.51.100.9' }, fields);

    assert.equal(cache.forget('192.0.2.1'), 2);
    assert.equal(cache.get(key), undefined);
    assert.ok(cache.get({ ...key, exporter: '198.51.100.9' }), 'the other exporter is untouched');
  });
});
