import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { describeRun, type KindCount, type VendorCount } from '../src/discovery/summary.js';
import type { DiscoveryRunRow } from '../src/discovery/service.js';

/**
 * What a run did, said once (`D-08`).
 *
 * **The headline is the part worth testing**, because it is the only thing most people read. The
 * counts underneath are arithmetic over columns and the database test proves they are the right
 * columns; the sentence is a set of judgements about which case somebody needs to see first, and
 * every one of those judgements can be wrong without anything failing.
 */

const RUN: DiscoveryRunRow = {
  id: 7,
  groupId: 95,
  probeId: 2,
  range: '10.0.0.0/24',
  total: 254,
  cursor: 254,
  found: 18,
  failed: 0,
  status: 'done',
  level: 'standard',
  templates: [],
  identified: 18,
  identifyCursor: 18,
  scheduleId: null,
  snmpCommunity: '',
  devicesCreated: 11,
  devicesMatched: 7,
  sensorsCreated: 20,
  provisionedAt: '2026-08-27T16:29:00.000Z',
  message: '',
  timeoutMs: 1_000,
  concurrency: 32,
  ratePerSecond: 0,
  createdAt: '2026-08-27T16:20:00.000Z',
  startedAt: '2026-08-27T16:20:01.000Z',
  finishedAt: '2026-08-27T16:28:01.000Z',
};

const run = (overrides: Partial<DiscoveryRunRow> = {}): DiscoveryRunRow => ({ ...RUN, ...overrides });

const describe_ = (
  overrides: Partial<DiscoveryRunRow> = {},
  kinds: KindCount[] = [],
  vendors: VendorCount[] = [],
  errors: { address: string; problem: string }[] = [],
) => describeRun(run(overrides), kinds, vendors, errors);

describe('the headline', () => {
  it('says what a finished run found and made', () => {
    assert.equal(
      describe_().headline,
      '10.0.0.0/24: 254 of 254 addresses swept, 18 hosts answered, 18 identified, ' +
        '11 devices and 20 sensors created, 7 already existed.',
    );
  });

  it('says a re-run created nothing new, which is what a re-run is checking', () => {
    // The promise idempotency makes, stated rather than left as three zeros to interpret.
    const summary = describe_({ devicesCreated: 0, sensorsCreated: 0, devicesMatched: 18 });
    assert.match(summary.headline, /nothing new — 18 devices already existed/);
  });

  it('distinguishes “created nothing” from “not provisioned yet”', () => {
    // Two very different situations that both show zero devices: one is a discovery waiting for
    // an operator to review the plan, the other is one that tried and made nothing.
    assert.match(
      describe_({ provisionedAt: null, devicesCreated: 0, sensorsCreated: 0, devicesMatched: 0 })
        .headline,
      /nothing created yet/,
    );
    assert.match(
      describe_({ devicesCreated: 0, sensorsCreated: 0, devicesMatched: 0 }).headline,
      /nothing created(?! yet)/,
    );
  });

  it('leads with the problems rather than burying them', () => {
    const summary = describe_({}, [], [], [
      { address: '10.0.0.5', problem: 'no credential' },
      { address: '10.0.0.9', problem: 'the template made no sensors' },
    ]);
    assert.match(summary.headline, /2 addresses had problems\.$/);
    assert.equal(summary.errors.length, 2, 'and they are in the summary, not behind a second call');
  });

  it('says how far a cancelled run got', () => {
    assert.equal(
      describe_({ status: 'cancelled', cursor: 132, found: 9 }).headline,
      'Cancelled after 132 of 254 addresses in 10.0.0.0/24, 9 hosts answered.',
    );
  });

  it('carries the run’s own sentence when it failed', () => {
    // "It failed" without the message sends somebody to the log for a sentence that exists.
    assert.match(
      describe_({ status: 'failed', cursor: 40, message: 'the probe disconnected' }).headline,
      /failed after 40 of 254 addresses: the probe disconnected/,
    );
  });

  it('reports progress while it is still going', () => {
    assert.equal(
      describe_({ status: 'running', cursor: 132, found: 9, identified: 0 }).headline,
      'Sweeping 10.0.0.0/24 — 132 of 254 addresses, 9 hosts answered.',
    );
    assert.match(
      describe_({ status: 'identifying', cursor: 254, identified: 4 }).headline,
      /Identifying what 10\.0\.0\.0\/24 found — 4 hosts of 18/,
    );
    assert.match(
      describe_({ status: 'queued', cursor: 0, found: 0 }).headline,
      /waiting for its probe — 254 addresses/,
    );
  });

  it('says one host rather than 1 hosts, and pluralises the range on its own size', () => {
    assert.match(
      describe_({ status: 'running', cursor: 1, found: 1 }).headline,
      /1 of 254 addresses, 1 host answered/,
    );
    // A /32 is one address, and "0 addresses of 1" is what pluralising the wrong half looks like.
    assert.match(
      describe_({ status: 'running', total: 1, cursor: 0, found: 0 }).headline,
      /0 of 1 address, 0 hosts answered/,
    );
  });
});

describe('the breakdown', () => {
  it('keeps a host nobody looked at apart from one the classifier could not place', () => {
    // A ping-only run has every host unidentified; that is not a failed classification, and
    // collapsing the two would make the most restrained level look like the most broken one.
    const summary = describe_({}, [
      { kind: 'linux', count: 9 },
      { kind: null, count: 6 },
      { kind: 'unknown', count: 3 },
    ]);
    assert.deepEqual(summary.found.byKind, [
      { kind: 'linux', count: 9 },
      { kind: 'unidentified', count: 6 },
      { kind: 'unknown', count: 3 },
    ]);
  });

  it('reads a kind this build has never heard of as unidentified', () => {
    // A newer probe classifying something this core does not know. Claiming it as a kind would
    // put a value in the vocabulary `D-03` maps to sensor sets that maps to nothing.
    assert.deepEqual(describe_({}, [{ kind: 'quantum-toaster', count: 2 }]).found.byKind, [
      { kind: 'unidentified', count: 2 },
    ]);
  });

  it('passes vendors through as they were found', () => {
    assert.deepEqual(
      describe_({}, [], [
        { vendor: 'Cisco', count: 4 },
        { vendor: 'HP', count: 1 },
      ]).found.byVendor,
      [
        { vendor: 'Cisco', count: 4 },
        { vendor: 'HP', count: 1 },
      ],
    );
  });
});

describe('the counts', () => {
  it('works out what was swept and heard nothing', () => {
    const summary = describe_({ cursor: 254, found: 18, failed: 2 });
    assert.equal(summary.scanned.unreachable, 234);
    assert.equal(summary.scanned.complete, true);
  });

  it('never reports a negative count between two messages', () => {
    // The three counters are written by different messages. A read landing between two of them
    // should say nothing surprising rather than say -3.
    assert.equal(describe_({ cursor: 4, found: 6, failed: 1 }).scanned.unreachable, 0);
  });

  it('is incomplete until the cursor reaches the end', () => {
    assert.equal(describe_({ cursor: 253 }).scanned.complete, false);
  });

  it('times the run and says how fast it swept', () => {
    const summary = describe_();
    assert.equal(summary.timing.durationMs, 480_000);
    assert.equal(summary.timing.addressesPerSecond, 0.5);
  });

  it('has no rate for a run that has not finished', () => {
    const summary = describe_({ status: 'running', finishedAt: null });
    assert.equal(summary.timing.durationMs, null);
    assert.equal(summary.timing.addressesPerSecond, null);
  });

  it('has no rate for a run that finished in no measurable time', () => {
    // A /32 against a host that answers immediately. Dividing by zero would report Infinity
    // addresses a second, which is a number nobody should be shown.
    const summary = describe_({ finishedAt: RUN.startedAt });
    assert.equal(summary.timing.durationMs, 0);
    assert.equal(summary.timing.addressesPerSecond, null);
  });

  it('carries the schedule that started it', () => {
    assert.equal(describe_({ scheduleId: 3 }).scheduleId, 3);
    assert.equal(describe_().scheduleId, null, 'and null for one somebody started');
  });
});
