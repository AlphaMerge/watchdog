import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { LookupCatalogue } from '../src/lookups/catalogue.js';
import { applyLookup, validateLookup, type LookupDefinition } from '../src/lookups/definition.js';
import { loadLookups } from '../src/lookups/loader.js';
import { rollUp, type ChannelReadingFacts } from '../src/state/limits.js';
import { NO_LIMITS } from '../src/state/limits.js';

const silent = pino({ level: 'silent' });
const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function withFiles(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ms-lookups-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, 'utf8');
  return dir;
}

const status: LookupDefinition = {
  id: 'test.status',
  name: 'Status',
  type: 'singleInt',
  undefinedState: 'warning',
  entries: [
    { value: 1, state: 'up', text: 'running' },
    { value: 2, state: 'down', text: 'stopped' },
    { value: 3, state: 'warning', text: 'starting' },
  ],
};

const band: LookupDefinition = {
  id: 'test.band',
  name: 'Band',
  type: 'range',
  undefinedState: 'down',
  entries: [
    { to: 50, state: 'up', text: 'healthy' },
    { from: 50, to: 80, state: 'warning', text: 'high' },
    { from: 80, state: 'down', text: 'critical' },
  ],
};

// -------------------------------------------------------------------------------------------
// Mapping a value.
// -------------------------------------------------------------------------------------------

describe('applying a lookup', () => {
  it('maps a listed value to its state and its words', () => {
    assert.deepEqual(applyLookup(status, 2), { state: 'down', text: 'stopped', defined: true });
    assert.deepEqual(applyLookup(status, 1), { state: 'up', text: 'running', defined: true });
  });

  it('falls to undefinedState for a value nobody listed, and says it was undefined', () => {
    // The case a lookup exists for. A device that starts returning status 9 must still have a
    // state, and it must be the one the lookup's author chose.
    assert.deepEqual(applyLookup(status, 9), { state: 'warning', text: '', defined: false });
  });

  it('treats a non-finite reading as undefined rather than throwing', () => {
    assert.equal(applyLookup(status, Number.NaN).defined, false);
    assert.equal(applyLookup(band, Number.POSITIVE_INFINITY).defined, false);
  });

  it('takes ranges as half-open, so adjacent bands neither overlap nor leave a gap', () => {
    assert.equal(applyLookup(band, 49.9).text, 'healthy');
    assert.equal(applyLookup(band, 50).text, 'high', 'from is inclusive');
    assert.equal(applyLookup(band, 79.9).text, 'high');
    assert.equal(applyLookup(band, 80).text, 'critical', 'to is exclusive');
  });

  it('lets a range be unbounded on either side', () => {
    assert.equal(applyLookup(band, -1_000).text, 'healthy');
    assert.equal(applyLookup(band, 1e9).text, 'critical');
  });
});

// -------------------------------------------------------------------------------------------
// Definitions that cannot mean anything.
// -------------------------------------------------------------------------------------------

describe('lookup validation', () => {
  it('accepts the definitions this build ships', () => {
    for (const definition of BUILT_IN_LOOKUPS) {
      assert.deepEqual(validateLookup(definition), [], definition.id);
    }
  });

  it('refuses a value listed twice, because which entry wins is authoring order', () => {
    const problems = validateLookup({
      ...status,
      entries: [
        { value: 1, state: 'up', text: 'running' },
        { value: 1, state: 'down', text: 'also running?' },
      ],
    });
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('more than once'));
  });

  it('refuses overlapping ranges, for the same reason', () => {
    const problems = validateLookup({
      ...band,
      entries: [
        { to: 60, state: 'up', text: 'healthy' },
        { from: 50, state: 'down', text: 'critical' },
      ],
    });
    assert.equal(problems.length, 1);
    assert.ok(problems[0]?.includes('overlap'));
  });

  it('refuses an empty range', () => {
    const problems = validateLookup({
      ...band,
      entries: [{ from: 80, to: 20, state: 'down', text: 'never' }],
    });
    assert.ok(problems.some((problem) => problem.includes('is empty')));
  });

  it('refuses an id nothing could reference', () => {
    assert.ok(validateLookup({ ...status, id: 'Not An Id' }).length > 0);
  });

  it('refuses a lookup with no entries, which maps everything to one state', () => {
    assert.ok(validateLookup({ ...status, entries: [] }).length > 0);
  });
});

// -------------------------------------------------------------------------------------------
// The catalogue.
// -------------------------------------------------------------------------------------------

describe('the lookup catalogue', () => {
  it('holds a definition and hands it back', () => {
    const catalogue = new LookupCatalogue();
    assert.equal(catalogue.register(status, 'test'), true);
    assert.equal(catalogue.get('test.status')?.name, 'Status');
    assert.deepEqual(catalogue.problems(), []);
  });

  it('refuses a bad definition and says why, rather than throwing', () => {
    // The loader is walking a directory an operator controls. One unusable file must not stop
    // the other twenty.
    const catalogue = new LookupCatalogue();
    assert.equal(catalogue.register({ ...status, entries: [] }, 'bad.json'), false);
    assert.equal(catalogue.has('test.status'), false);
    assert.equal(catalogue.problems().length, 1);
    assert.equal(catalogue.problems()[0]?.source, 'bad.json');
  });

  it('reports a shape problem the schema catches, not only a semantic one', () => {
    const catalogue = new LookupCatalogue();
    const broken = { ...status, undefinedState: 'sideways' } as unknown as LookupDefinition;
    assert.equal(catalogue.register(broken, 'bad.json'), false);
    assert.ok(catalogue.problems()[0]?.problems.join(' ').includes('undefinedState'));
  });

  it('lets a custom definition replace a built-in with the same id', () => {
    const catalogue = new LookupCatalogue();
    const builtIn: LookupDefinition = { ...status, name: 'Shipped' };
    catalogue.register(builtIn, 'built-in', true);
    catalogue.register({ ...status, name: 'The operator’s' }, '/data/lookups/status.json');

    assert.equal(catalogue.get('test.status')?.name, 'The operator’s');
    const summary = catalogue.summaries().find((each) => each.id === 'test.status');
    assert.equal(summary?.overridesBuiltIn, true, 'and says so, because it is surprising');
    assert.equal(summary.source, '/data/lookups/status.json');
  });

  it('refuses a second custom definition for one id, rather than picking by directory order', () => {
    const catalogue = new LookupCatalogue();
    assert.equal(catalogue.register(status, '/data/lookups/a.json'), true);
    assert.equal(catalogue.register(status, '/data/lookups/b.json'), false);
    assert.ok(catalogue.problems()[0]?.problems[0]?.includes('a.json'));
  });

  it('refuses to register once sealed', () => {
    const catalogue = new LookupCatalogue().seal();
    assert.throws(() => catalogue.register(status, 'late'), /sealed/);
  });
});

// -------------------------------------------------------------------------------------------
// Loading from disk.
// -------------------------------------------------------------------------------------------

describe('loading lookups', () => {
  it('ships its built-ins when there is nothing to read', async () => {
    const catalogue = await loadLookups({ logger: silent });
    assert.deepEqual([...catalogue.ids()], [...BUILT_IN_LOOKUPS.map((each) => each.id)].sort());
    assert.equal(catalogue.sealed, true);
  });

  it('treats a missing directory as normal, not as a problem', async () => {
    // Most installations never write a lookup. A warning on every start for a directory nobody
    // needs is a warning everybody learns to ignore.
    const catalogue = await loadLookups({ directory: '/nonexistent/lookups', logger: silent });
    assert.deepEqual(catalogue.problems(), []);
    assert.ok(catalogue.ids().length > 0);
  });

  it('loads what an operator wrote, on top of the built-ins', async () => {
    const directory = await withFiles({ 'status.json': JSON.stringify(status) });
    const catalogue = await loadLookups({ directory, logger: silent });
    assert.equal(catalogue.get('test.status')?.name, 'Status');
    assert.ok(catalogue.has('ms.snmp.if-oper-status'), 'and kept the shipped ones');
  });

  it('overrides a built-in by id, which is the whole point of the directory', async () => {
    const override: LookupDefinition = {
      id: 'ms.snmp.if-oper-status',
      name: 'Interface status (this site)',
      type: 'singleInt',
      // A site whose kit reports 2 during a normal failover, and does not want an alarm for it.
      undefinedState: 'warning',
      entries: [
        { value: 1, state: 'up', text: 'up' },
        { value: 2, state: 'warning', text: 'down (expected during failover)' },
      ],
    };
    const directory = await withFiles({ 'if.json': JSON.stringify(override) });
    const catalogue = await loadLookups({ directory, logger: silent });

    const loaded = catalogue.get('ms.snmp.if-oper-status');
    assert.ok(loaded);
    assert.equal(loaded.name, 'Interface status (this site)');
    assert.equal(applyLookup(loaded, 2).state, 'warning');
  });

  it('records a file that is not JSON, rather than failing the start', async () => {
    const directory = await withFiles({
      'broken.json': '{ not json',
      'good.json': JSON.stringify(status),
    });
    const catalogue = await loadLookups({ directory, logger: silent });

    assert.equal(catalogue.has('test.status'), true, 'the other file still loaded');
    assert.equal(catalogue.problems().length, 1);
    assert.ok(catalogue.problems()[0]?.problems[0]?.includes('not valid JSON'));
  });

  it('ignores anything that is not a .json file', async () => {
    const directory = await withFiles({ 'notes.txt': 'a note to self', 'x.json.bak': 'junk' });
    const catalogue = await loadLookups({ directory, logger: silent });
    assert.deepEqual(catalogue.problems(), []);
  });
});

// -------------------------------------------------------------------------------------------
// What a lookup does to a channel's state — §2.2, the other half of M-04.
// -------------------------------------------------------------------------------------------

describe('a channel judged by a lookup', () => {
  const reading = (value: number, lookup: LookupDefinition | null): ChannelReadingFacts => ({
    key: 'status',
    name: 'Interface status',
    unit: '',
    value,
    decimals: null,
    limits: NO_LIMITS,
    lookupId: lookup?.id ?? null,
    lookup,
  });

  it('is Up with nothing to say when the value maps to up', () => {
    const outcome = rollUp([reading(1, status)]);
    assert.deepEqual(outcome.verdict, { state: 'up', cause: 'scan' });
    assert.equal(outcome.breaches.length, 0);
  });

  it('is Down on the very first reading, attributed to the lookup', () => {
    const outcome = rollUp([reading(2, status)]);
    assert.deepEqual(outcome.verdict, { state: 'down', cause: 'lookup' });
  });

  it('keeps the raw number as well as what it means', () => {
    // Either alone is worse: the number is what the device said, the text is what an operator
    // can act on, and a lookup edited since makes the two disagree in a way only the pair shows.
    assert.equal(rollUp([reading(2, status)]).message, 'Interface status is 2 (stopped)');
  });

  it('names the lookup when the value is not in it, because that is where the fix goes', () => {
    assert.equal(
      rollUp([reading(9, status)]).message,
      'Interface status is 9, which test.status does not define',
    );
  });

  it('is judged by the lookup instead of its limits, never by both', () => {
    // A lookup maps discrete codes and a limit bounds a continuous range. A channel whose value
    // is a status code has no meaningful threshold, and applying one anyway would let a limit
    // somebody set years ago override what the device is actually saying.
    const withBoth: ChannelReadingFacts = {
      ...reading(1, status),
      limits: { ...NO_LIMITS, upperError: 0 },
    };
    assert.equal(rollUp([withBoth]).verdict.state, 'up', 'the lookup says running');
  });

  it('says so, in Warning, when the lookup it names is not loaded', () => {
    // Not silence — a sensor reading Up because nothing could judge it is worse than one that
    // says it does not know. Not a fall back to limits either, because the reason to configure
    // a lookup is that a threshold is the wrong tool for the value. And not Down: the check
    // succeeded, and what is broken is this system's ability to read the answer.
    const unresolved: ChannelReadingFacts = {
      ...reading(2, null),
      lookupId: 'acme.not-loaded',
      limits: { ...NO_LIMITS, upperError: 1 },
    };
    const outcome = rollUp([unresolved]);
    assert.deepEqual(outcome.verdict, { state: 'warning', cause: 'lookup' });
    assert.equal(
      outcome.message,
      'Interface status is 2, but the lookup it is judged by (acme.not-loaded) is not loaded',
    );
  });

  it('is judged by its limits when no lookup is configured at all', () => {
    const plain: ChannelReadingFacts = {
      ...reading(2, null),
      limits: { ...NO_LIMITS, upperError: 1 },
    };
    assert.equal(rollUp([plain]).verdict.state, 'down');
  });

  it('takes the worst across channels whichever way each is judged', () => {
    const limited: ChannelReadingFacts = {
      key: 'rtt',
      name: 'Response time',
      unit: 'ms',
      value: 900,
      decimals: null,
      limits: { ...NO_LIMITS, upperWarning: 100 },
      lookupId: null,
      lookup: null,
    };
    const outcome = rollUp([limited, reading(2, status)]);
    assert.deepEqual(outcome.verdict, { state: 'down', cause: 'lookup' }, 'the lookup was worse');
    assert.equal(outcome.breaches.length, 2);
    assert.equal(outcome.breaches[0]?.cause, 'lookup');
    assert.equal(outcome.breaches[1]?.cause, 'limit');
  });
});
