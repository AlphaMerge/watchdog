import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pino } from 'pino';
import { BUILT_IN_LOOKUPS } from '../src/lookups/built-in.js';
import { LookupCatalogue } from '../src/lookups/catalogue.js';
import {
  applyLookup,
  lookupDefinitionSchema,
  validateLookup,
  type LookupDefinition,
} from '../src/lookups/definition.js';
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

  it('says how a probe resolves names, every mode Up, and Warns only for its lookup helper failing (`P-432`)', () => {
    const named = (id: string): LookupDefinition => {
      const found = BUILT_IN_LOOKUPS.find((definition) => definition.id === id);
      assert.ok(found !== undefined, id);
      return found;
    };
    // A mode is a setting, and a resting helper is the latch's to alarm on: Up, even unlisted.
    const mode = named('ms.probe.name-resolver');
    assert.deepEqual(
      [1, 2, 3, 4].map((value) => applyLookup(mode, value).state),
      ['up', 'up', 'up', 'up'],
    );
    assert.deepEqual(
      [1, 2, 3].map((value) => applyLookup(mode, value).text),
      ['system', 'gate', 'gate, with its lookup helper resting: names are asked as with system'],
    );
    const trouble = named('ms.probe.lookup-helper');
    assert.deepEqual(applyLookup(trouble, 0), { state: 'up', text: 'answering', defined: true });
    const failing = applyLookup(trouble, 1);
    assert.equal(failing.state, 'warning', 'a Warning: names are still answered');
    assert.match(failing.text, /^failing: .*read the probe log’s lookup helper lines$/u);
    assert.equal(applyLookup(trouble, 2).state, 'warning', 'a value it does not know warns');
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

  it('refuses a singleInt entry with no value, which nothing can ever match', () => {
    // **`P-101`.** One `items` schema served both lookup types with `value`, `from` and `to` all
    // optional, so a forgotten `"value": 3` was accepted. `applyLookup`'s `each.value === value`
    // never matched it: the reading fell to `undefinedState` — Up, on most definitions — while
    // the message told the operator the lookup "does not define" a code they can see in their
    // own file. `docs/state-machine.md` §2.2.1: a definition that is wrong is refused, not
    // repaired.
    //
    // **Through `register`, because the boundary is where this is caught.** `LookupDefinition`
    // in TypeScript already requires `value`; only the schema guards a file on disk, so a test
    // calling `validateLookup` directly would be checking a shape the compiler says cannot
    // exist. The JSON round-trip is the same door the loader uses.
    const catalogue = new LookupCatalogue();
    const written = JSON.parse(
      JSON.stringify({
        ...status,
        entries: [
          { value: 1, state: 'up', text: 'up' },
          { value: 2, state: 'down', text: 'down' },
          { state: 'warning', text: 'testing' },
        ],
      }),
    ) as LookupDefinition;

    assert.equal(catalogue.register(written, '/data/lookups/status.json'), false);
    const reported = catalogue.problems()[0]?.problems.join('; ') ?? '';
    assert.ok(reported.includes('value'), reported);
  });

  it('refuses a range entry with neither bound, which matches everything', () => {
    // The mirror case. `(-inf, +inf)` trips neither the empty-range check nor the overlap check
    // when it is the only entry, so one unbounded entry was accepted and forced every reading
    // to its state.
    const catalogue = new LookupCatalogue();
    const written = JSON.parse(
      JSON.stringify({ ...band, entries: [{ state: 'down', text: 'anything at all' }] }),
    ) as LookupDefinition;

    assert.equal(catalogue.register(written, '/data/lookups/band.json'), false);
    assert.ok((catalogue.problems()[0]?.problems.length ?? 0) > 0);
  });

  it('still allows a range open at one end, which is the ordinary case', () => {
    // "Above 90 is critical" has no upper bound and is exactly what these are for. The rule is
    // that an entry must bound at least one side, not both — a fix that refused these would be
    // worse than the defect.
    const catalogue = new LookupCatalogue();
    assert.equal(
      catalogue.register(
        {
          ...band,
          entries: [
            { to: 90, state: 'up', text: 'fine' },
            { from: 90, state: 'down', text: 'critical' },
          ],
        },
        '/data/lookups/band.json',
      ),
      true,
      catalogue.problems()[0]?.problems.join('; '),
    );
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

  it('refuses a second custom definition even when the id has a built-in', () => {
    // **`P-100`.** The guard asked `!this.#builtInIds.has(id)` — a question about the *id*
    // rather than about what currently holds it — and `#builtInIds` is never cleared. So for
    // every id this build ships, the guard was permanently disabled: two operator files
    // claiming `ms.snmp.if-oper-status` were resolved by directory order, with no entry in
    // `problems()`, and renaming a file silently changed which one judged every interface
    // sensor in the installation.
    //
    // The case above uses an id with no built-in, which is why it stayed green: that path was
    // always correct. Overriding a built-in *once* is still the whole point of the directory,
    // so both halves are asserted here.
    const catalogue = new LookupCatalogue();
    catalogue.register({ ...status, name: 'Shipped' }, 'built-in', true);

    assert.equal(
      catalogue.register({ ...status, name: 'First' }, '/data/lookups/a.json'),
      true,
      'one operator file may replace a built-in',
    );
    assert.equal(
      catalogue.register({ ...status, name: 'Second' }, '/data/lookups/b.json'),
      false,
      'a second may not, whatever the directory order says',
    );
    assert.ok(catalogue.problems()[0]?.problems[0]?.includes('a.json'));
    assert.equal(catalogue.get('test.status')?.name, 'First', 'and the refusal changed nothing');
  });

  it('refuses to register once sealed', () => {
    const catalogue = new LookupCatalogue().seal();
    assert.throws(() => catalogue.register(status, 'late'), /sealed/);
  });

  it('refuses a schema with a pattern and no sentence, or a sentence and no pattern (P-377)', () => {
    // As the sensor catalogue (`U-53`) and the method registry (`P-372`) refuse one: a file a
    // pattern refuses is told its sentence in `problems()`, so a pattern without one would show
    // the operator the expression.
    const withId = (id: Record<string, unknown>): LookupCatalogue =>
      new LookupCatalogue({
        ...lookupDefinitionSchema,
        properties: { ...lookupDefinitionSchema.properties, id },
      });
    assert.throws(
      () => withId({ type: 'string', pattern: '^[a-z.]+$' }),
      /the lookup schema gives "id" a pattern without x-patternMessage/,
    );
    assert.throws(
      () => withId({ type: 'string', 'x-patternMessage': 'must be dotted lowercase words' }),
      /the lookup schema gives "id" x-patternMessage without a pattern/,
    );
    // And one that says it is taken, and says it in `problems()`, without the value.
    const said = withId({
      type: 'string',
      pattern: '^[a-z.]+$',
      'x-patternMessage': 'must be dotted lowercase words',
    });
    assert.equal(said.register({ ...status, id: 'test.canary-1' }, 'bad.json'), false);
    assert.deepEqual(said.problems()[0]?.problems, ['/id must be dotted lowercase words']);
    // The shipped schema passes the same check: the default catalogue is built from it.
    assert.equal(new LookupCatalogue().register(status, 'test'), true);
  });

  it('refuses a schema with a mistyped keyword, which used to constrain nothing (P-379)', () => {
    const withName = (name: Record<string, unknown>): LookupCatalogue =>
      new LookupCatalogue({
        ...lookupDefinitionSchema,
        properties: { ...lookupDefinitionSchema.properties, name },
      });
    assert.throws(
      () => withName({ type: 'string', maxLenght: 200 }),
      /unknown keyword: "maxLenght"/,
    );
    // Spelt right, it is taken, and holds a definition to it.
    const held = withName({ type: 'string', maxLength: 3 });
    assert.equal(held.register({ ...status, name: 'Four' }, 'long.json'), false);
  });

  /**
   * Strict mode asked the two `then`s for the types and names they require (`P-379`). They take
   * and refuse what they did: every built-in, an entry open at one end, and nothing missing what
   * its kind needs.
   */
  it('takes and refuses what it did before strict mode asked its schema to declare more', () => {
    const catalogue = new LookupCatalogue();
    for (const builtIn of BUILT_IN_LOOKUPS) {
      assert.equal(catalogue.register(builtIn, 'built-in', true), true, builtIn.id);
    }
    const range = (id: string, entries: unknown[]): LookupDefinition =>
      ({ ...status, id, type: 'range', entries }) as unknown as LookupDefinition;
    const single = (id: string, entries: unknown[]): LookupDefinition =>
      ({ ...status, id, entries }) as unknown as LookupDefinition;
    const taken = [
      range('test.range.from', [{ from: 90, state: 'down', text: 'hot' }]),
      range('test.range.to', [{ to: 10, state: 'warning', text: 'cold' }]),
      range('test.range.both', [{ from: 10, to: 90, state: 'up', text: 'fine' }]),
      single('test.single', [{ value: 1, state: 'up', text: 'one' }]),
    ];
    for (const definition of taken) {
      assert.equal(
        catalogue.register(definition, 'taken.json'),
        true,
        JSON.stringify(catalogue.problems()),
      );
    }
    const refused: [LookupDefinition, string][] = [
      [
        range('test.range.open', [{ state: 'up', text: 'any' }]),
        "must have one of the properties 'from' or 'to'",
      ],
      [
        single('test.single.none', [{ state: 'up', text: 'none' }]),
        "must have required property 'value'",
      ],
      [
        single('test.single.text', [{ value: 1, state: 'up' }]),
        "must have required property 'text'",
      ],
    ];
    for (const [definition, said] of refused) {
      assert.equal(catalogue.register(definition, 'refused.json'), false, definition.id);
      const problems = catalogue.problems().find((p) => p.id === definition.id)?.problems ?? [];
      assert.ok(
        problems.some((line) => line === `/entries/0 ${said}`),
        JSON.stringify(problems),
      );
    }
  });
});

describe('what a refused lookup is told (P-384)', () => {
  /**
   * Each problem once, and no "must match \"then\" schema" over the lines it wraps. A `then` that
   * repeats what `properties` holds fails with the same sentence at the same path, so these were
   * each said twice and wrapped once besides.
   */
  const ROWS: {
    name: string;
    type: 'singleInt' | 'range';
    id?: string;
    entries: unknown;
    said: string[];
  }[] = [
    {
      name: 'an entry with no state',
      type: 'singleInt',
      entries: [{ value: 1, text: 'one' }],
      said: ["/entries/0 must have required property 'state'"],
    },
    {
      name: 'a range entry with no state',
      type: 'range',
      entries: [{ from: 1, text: 'one' }],
      said: ["/entries/0 must have required property 'state'"],
    },
    {
      name: 'entries that are a number',
      type: 'singleInt',
      entries: 5,
      said: ['/entries must be array'],
    },
    {
      name: 'entries that are a string',
      type: 'singleInt',
      entries: 'none',
      said: ['/entries must be array'],
    },
    {
      name: 'range entries that are an object',
      type: 'range',
      entries: { from: 1, state: 'up', text: 'one' },
      said: ['/entries must be array'],
    },
    {
      name: 'an entry that is a number',
      type: 'singleInt',
      entries: [5, 6],
      said: ['/entries/0 must be object', '/entries/1 must be object'],
    },
    {
      name: 'a range entry that is null',
      type: 'range',
      entries: [null],
      said: ['/entries/0 must be object'],
    },
    {
      // Arrays are not objects to the schema, and were to the guard before it (`P-384` review).
      name: 'entries that are arrays',
      type: 'singleInt',
      entries: [
        [1, 'up', 'one'],
        [2, 'down', 'two'],
      ],
      said: ['/entries/0 must be object', '/entries/1 must be object'],
    },
    {
      // Not "value undefined is listed more than once" besides.
      name: 'two entries with no value',
      type: 'singleInt',
      entries: [
        { state: 'up', text: 'one' },
        { state: 'down', text: 'two' },
      ],
      said: [
        "/entries/0 must have required property 'value'",
        "/entries/1 must have required property 'value'",
      ],
    },
    {
      // One line for the choice, not two requirements and an `anyOf` over them.
      name: 'a range entry with neither bound',
      type: 'range',
      entries: [{ state: 'down', text: 'anything' }],
      said: ["/entries/0 must have one of the properties 'from' or 'to'"],
    },
    {
      // The schema's sentence, not the schema's and `validateLookup`'s for one problem.
      name: 'no entries at all',
      type: 'singleInt',
      entries: [],
      said: ['/entries must NOT have fewer than 1 items'],
    },
    {
      // A bound that is there satisfies the `anyOf`; its type is the one problem.
      name: 'a range entry whose bound is not a number',
      type: 'range',
      entries: [{ from: 'ten', state: 'down', text: 'hot' }],
      said: ['/entries/0/from must be number'],
    },
    {
      // And the id is still read when the entries are not.
      name: 'an unusable id beside unreadable entries',
      type: 'singleInt',
      id: 'Not An Id',
      entries: 5,
      said: [
        '/entries must be array',
        '"Not An Id" is not a usable lookup id; expected something like "ms.snmp.if-oper-status"',
      ],
    },
  ];
  for (const row of ROWS) {
    it(`says ${row.name} once`, () => {
      const catalogue = new LookupCatalogue();
      const definition = {
        ...status,
        ...(row.id === undefined ? {} : { id: row.id }),
        type: row.type,
        entries: row.entries,
      } as unknown as LookupDefinition;
      assert.equal(catalogue.register(definition, 'refused.json'), false);
      assert.deepEqual(catalogue.problems(), [
        { id: row.id ?? 'test.status', source: 'refused.json', problems: row.said },
      ]);
    });
  }

  it('loads the files beside one whose entries are not an array', async () => {
    const directory = await withFiles({
      'a-broken.json': JSON.stringify({ ...status, id: 'test.broken', entries: 5 }),
      'b-status.json': JSON.stringify(status),
    });
    const catalogue = await loadLookups({ directory, logger: silent });
    assert.equal(catalogue.has('test.status'), true);
    assert.deepEqual(
      catalogue.problems().map((one) => [one.id, one.problems]),
      [['test.broken', ['/entries must be array']]],
    );
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
