import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DnsSimulator, dnsQuery, replies, type DnsQueryRecord } from '@ms/simulators';
import { BUILT_TREES, BuildWatch, buildDigest } from './differential/names-build.js';
import { startCapture, type CaptureOptions } from './differential/names-capture.js';
import {
  ANSWER_PLAN,
  ANSWER_ROWS,
  BUDGET_FORWARD_MAX,
  BUDGET_GATE_EXTRA,
  BUDGET_LOSS_TRANSIENT,
  BUDGET_NAMES,
  NAMESERVER,
  OFF_CASES,
  STUB,
  WITHIN_MS,
  answerExpectation,
  answerProblems,
  answerRowsDigest,
  budgetProblems,
  canonicalAddress,
  classificationProblem,
  digestOf,
  expectationIn,
  firstAsks,
  judgePlan,
  listenerOf,
  modesProblems,
  nameserversOf,
  offProblems,
  optOf,
  optProblems,
  parseRun,
  pcapQuestions,
  recordingsFile,
  resolvedObserved,
  unplayable,
  verify as verifyAt,
  verifyBoxes as verifyBoxesAt,
  walkProblems,
  wireOf,
  type AnswerRow,
  type BudgetRun,
  type Classification,
  type Current,
  type Expectation,
  type GlibcOpt,
  type ImageRun,
  type InImage,
  type ModesRun,
  type OffCase,
  type OffRun,
  type Plan,
  type PlanRun,
  type RecordingsFile,
  type Row,
  type RowRun,
  type RowsFile,
  type WalkRun,
  type Wire,
} from './differential/names-differential.js';
import type { ModesReply, ModesRequest } from './differential/names-modes.js';
import {
  NEUTRAL,
  walkAndModes,
  type ModesChannel,
  type WalkSimulator,
} from './differential/names-walk.js';
import { within } from './support/within.js';

/**
 * The differential's judgement (`P-432` S8, D30): the pure half of `names-replay` and
 * `names-verify`, which `scripts/smoke/name-gate-differential.sh` runs in each image. What glibc
 * sent is held against S4's rows here by the same functions that judge a real run, so a judgement
 * that let a disagreement through would let it through in every image.
 */

const ROWS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/system-names-rows.json', import.meta.url)),
    'utf8',
  ),
) as RowsFile;

const ONE: Expectation = {
  class: 'walk',
  candidates: ['sw1.corp.example', 'sw1'],
  types: ['A', 'AAAA'],
  servers: ['10.0.0.53'],
  rotate: false,
  timeout: 5,
  attempts: 2,
  plans: [
    {
      plan: 'nxdomain',
      answers: { '10.0.0.53': { A: 'nxdomain', AAAA: 'nxdomain' } },
      wire: [
        ['10.0.0.53', 'sw1.corp.example', 'A', 1],
        ['10.0.0.53', 'sw1.corp.example', 'AAAA', 1],
        ['10.0.0.53', 'sw1', 'A', 1],
        ['10.0.0.53', 'sw1', 'AAAA', 1],
      ],
    },
    {
      plan: 'answer',
      answers: { '10.0.0.53': { A: 'address', AAAA: 'address' } },
      wire: [
        ['10.0.0.53', 'sw1.corp.example', 'A', 1],
        ['10.0.0.53', 'sw1.corp.example', 'AAAA', 1],
      ],
    },
  ],
};

const ROTATING: Expectation = {
  class: 'walk',
  candidates: ['sw1'],
  types: ['A'],
  servers: ['10.0.0.1', '10.0.0.2'],
  rotate: true,
  timeout: 5,
  attempts: 2,
  plans: [
    {
      plan: 'last-answers-after-servfail',
      answers: { '10.0.0.1': { A: 'servfail' }, '10.0.0.2': { A: 'address' } },
      wireByOffset: [
        [
          ['10.0.0.1', 'sw1', 'A', 1],
          ['10.0.0.2', 'sw1', 'A', 1],
        ],
        [['10.0.0.2', 'sw1', 'A', 1]],
      ],
    },
  ],
};

const ROW: Row = {
  id: 'aaaaaaaaaaaaaaaa',
  title: 'a walked name',
  world: {
    glibc: '2.39',
    hostname: 'probe-1',
    env: {},
    files: {},
    missingModules: [],
    addresses: ['10.0.0.53'],
    ipv6: false,
  },
  question: { name: 'sw1', family: 0 },
  expect: ONE,
  byImage: {},
};

const RESOLV_ROWS: RowsFile = {
  schema: 3,
  images: { debian12: '2.36', ubuntu2404: '2.39' },
  resolved: ['ubuntu2404'],
  texts: {},
  rows: [ROW, { ...ROW, id: 'bbbbbbbbbbbbbbbb', expect: ROTATING, byImage: { debian12: null } }],
};

/** What the policy reads of a row, as the replay records it. */
function classified(e: Expectation): InImage {
  return {
    class: e.class,
    ...(e.via === undefined ? {} : { via: e.via }),
    ...(e.candidates === undefined ? {} : { candidates: e.candidates }),
    ...(e.types === undefined ? {} : { types: e.types }),
    servers: e.servers,
    rotate: e.rotate,
    timeout: e.timeout,
    attempts: e.attempts,
  };
}

/** The rows file, the policy's build, the answer rows and the build every run below ran. */
const CURRENT: Current = {
  rowsDigest: 'r0',
  policyDigest: 'p0',
  answerRowsDigest: 'a0',
  buildDigest: 'b0',
};
const verify = (rows: RowsFile, runs: readonly ImageRun[]): ReturnType<typeof verifyAt> =>
  verifyAt(rows, runs, CURRENT);

const ANSWERED = 'answer:192.0.2.53';

/** Each question of a wire once, at its first try, the transport aside: what a faithful walk asks. */
function firstWire(wire: readonly Wire[]): Wire[] {
  const out: Wire[] = [];
  for (const [server, name, type] of wire) {
    const bare = server.replace(/\/tcp$/u, '');
    if (!out.some(([s, n, t]) => s === bare && n === name && t === type))
      out.push([bare, name, type, 1]);
  }
  return out;
}

/** Whether a plan leaves some server silent: glibc then waits out a try, and the walk is not heard. */
function silentIn(plan: Plan): boolean {
  return Object.values(plan.answers).some((byType) => Object.values(byType).includes('silent'));
}

/**
 * The walk a faithful check sends for a plan whose glibc wire is `wire` (`P-460`): what glibc
 * asked first, to the first silent server when there is one; under `rotate` every server at once.
 */
function faithfulWalk(e: Expectation, plan: Plan, wire: readonly Wire[]): WalkRun {
  if (e.class !== 'walk') return { route: 'local', wire: [], opt: [], ms: 0.1 };
  const silent = silentIn(plan);
  const types = e.types ?? ['A', 'AAAA'];
  let walked: Wire[];
  if (e.rotate && e.servers.length > 1) {
    const names = [...new Set(wire.map(([, name]) => name))];
    walked = (silent ? names.slice(0, 1) : names).flatMap((name) =>
      (silent ? types.slice(0, 1) : types).flatMap((type) =>
        e.servers.map((server): Wire => [server, name, type, 1]),
      ),
    );
  } else {
    const first = firstWire(wire);
    const stop = first.findIndex(
      ([server, , type]) => plan.answers[server]?.[type as 'A' | 'AAAA'] === 'silent',
    );
    walked = stop === -1 ? first : first.slice(0, stop + 1);
  }
  return { route: silent ? 'silent' : 'heard', wire: walked, opt: walked.map(() => false), ms: 2 };
}

const modesFor = (route: string): ModesRun => ({
  system: ANSWERED,
  gate: ANSWERED,
  gateRan: route === 'silent' ? 'helper' : 'lanes',
  helper: ANSWERED,
  lanes: ANSWERED,
});

/** Whether a row's resolv.conf says `options edns0`, as the policy in a faithful image reads it. */
function edns0Of(rows: RowsFile, row: Row): boolean {
  const id = row.world.files['/etc/resolv.conf'];
  return id !== undefined && /^options .*\bedns0\b/mu.test(rows.texts[id] ?? '');
}

const optFor = (expected: GlibcOpt, wire: readonly Wire[]): boolean[] =>
  wire.map((_, k) => expected === 'every' || (expected === 'then-none' && k === 0));

/** An answer row played by a glibc and a check that did what it claims. */
function faithfulAnswer(row: AnswerRow): RowRun {
  const walked = firstWire(row.wire).slice(0, row.walk === 'heard' ? undefined : 1);
  return {
    id: row.id,
    inImage: classified({ ...answerExpectation(row), plans: [] }),
    edns0: row.glibcOpt !== 'none',
    plans: [
      {
        plan: ANSWER_PLAN,
        wire: row.wire,
        opt: optFor(row.glibcOpt, row.wire),
        outcome: row.outcome,
        ms: row.fast ? 3 : 1_500,
        walk: { route: row.walk, wire: walked, opt: walked.map(() => false), ms: 2 },
        modes: modesFor(row.walk),
      },
    ],
  };
}

/** A run in which glibc did exactly what the policy says: each plan's wire, the first offset. */
function faithful(rows: RowsFile, image: string, glibc = rows.images[image]): ImageRun {
  const out: RowRun[] = [];
  for (const row of rows.rows) {
    const e = expectationIn(row, image);
    if (e === null) continue;
    const edns0 = edns0Of(rows, row);
    out.push({
      id: row.id,
      inImage: classified(e),
      edns0,
      plans: e.plans.map((plan) => {
        const wire = plan.wire ?? plan.wireByOffset?.[0] ?? [];
        const walk = faithfulWalk(e, plan, wire);
        return {
          plan: plan.plan,
          wire,
          opt: wire.map(() => edns0),
          outcome: 'answer:1',
          ms: walk.route === 'silent' ? 5_000 : 3.4,
          walk,
          modes: modesFor(walk.route),
        };
      }),
    });
  }
  return {
    image,
    glibc,
    node: 'v24.19.0',
    base: `base-of-${image}`,
    digest: 'sha256:0',
    rowsDigest: CURRENT.rowsDigest,
    policyDigest: CURRENT.policyDigest,
    answerRowsDigest: CURRENT.answerRowsDigest,
    buildDigest: CURRENT.buildDigest,
    resolved: rows.resolved.includes(image),
    rows: out,
    answers: ANSWER_ROWS.map(faithfulAnswer),
  };
}

describe('the differential: a wire from what the servers saw', () => {
  it('numbers each try of a question at a server, and marks one over TCP', () => {
    const asked = [
      { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'udp', opt: true },
      { server: '10.0.0.1', qname: 'sw1', qtype: 'AAAA', transport: 'udp', opt: true },
      { server: '10.0.0.2', qname: 'sw1', qtype: 'A', transport: 'udp', opt: false },
      { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'udp', opt: true },
      { server: '10.0.0.1', qname: 'sw1', qtype: 'A', transport: 'tcp', opt: false },
    ] as const;
    assert.deepEqual(wireOf(asked), [
      ['10.0.0.1', 'sw1', 'A', 1],
      ['10.0.0.1', 'sw1', 'AAAA', 1],
      ['10.0.0.2', 'sw1', 'A', 1],
      ['10.0.0.1', 'sw1', 'A', 2],
      ['10.0.0.1/tcp', 'sw1', 'A', 1],
    ]);
    // Each question's OPT record, in the same order.
    assert.deepEqual(optOf(asked), [true, true, false, true, false]);
  });
});

describe('the differential: the policy in the image against the row', () => {
  it('agrees when every field is the row’s', () => {
    assert.equal(classificationProblem(ONE, classified(ONE)), undefined);
  });

  it('names the check off in the image, and each field read otherwise', () => {
    assert.match(
      classificationProblem(ONE, { class: 'off', off: 'module: myhostname is not installed' }) ??
        '',
      /check is off in the image: module: myhostname/u,
    );
    const cases: [Partial<InImage>, RegExp][] = [
      [{ class: 'local', via: 'hosts' }, /reads class as "local"/u],
      [{ candidates: ['sw1', 'sw1.corp.example'] }, /reads candidates as/u],
      [{ types: ['A'] }, /reads types as \["A"\]/u],
      [{ servers: ['10.0.0.54'] }, /reads servers as/u],
      [{ rotate: true }, /reads rotate as true/u],
      [{ timeout: 30 }, /reads timeout as 30, the row says 5/u],
      [{ attempts: 9 }, /reads attempts as 9, the row says 2/u],
    ];
    for (const [change, message] of cases) {
      const read = { ...classified(ONE), ...change } as InImage;
      assert.match(classificationProblem(ONE, read) ?? '', message, JSON.stringify(change));
    }
    const local: Expectation = { ...ONE, class: 'local', via: 'hosts', plans: [] };
    assert.match(
      classificationProblem(local, { ...classified(local), via: 'myhostname' } as InImage) ?? '',
      /reads via as "myhostname"/u,
    );
  });
});

describe('the differential: a plan against the wire glibc sent', () => {
  const sent = (plan: string, wire: readonly Wire[]) => ({ plan, wire, outcome: 'x', ms: 1 });

  it('agrees only with the plan’s wire exactly: no extra, missing, reordered or retried question', () => {
    const wire = ONE.plans[0]?.wire ?? [];
    assert.deepEqual(judgePlan(ONE, sent('nxdomain', wire)), { ok: true });
    const wrong: (readonly Wire[])[] = [
      wire.slice(1),
      [...wire, ['10.0.0.53', 'sw1', 'A', 2]],
      [wire[1], wire[0], wire[2], wire[3]].filter((w) => w !== undefined),
      wire.map((w): Wire => [w[0], w[1], w[2], 2]),
      [...wire.slice(0, 3), ['127.0.0.1', 'sw1', 'AAAA', 1]],
      [],
    ];
    for (const each of wrong) {
      const verdict = judgePlan(ONE, sent('nxdomain', each));
      assert.ok(!verdict.ok, JSON.stringify(each));
      assert.match(verdict.problem, /^nxdomain: the policy expects .* glibc sent/u);
    }
    // A local name: glibc must send nothing at all.
    const local: Expectation = {
      ...ONE,
      class: 'local',
      via: 'hosts',
      plans: [{ plan: 'nxdomain', answers: {}, wire: [] }],
    };
    assert.deepEqual(judgePlan(local, sent('nxdomain', [])), { ok: true });
    assert.equal(judgePlan(local, sent('nxdomain', [['10.0.0.53', 'printer', 'A', 1]])).ok, false);
  });

  it('under rotate, finds which server glibc started at, and refuses any other wire', () => {
    const plan = 'last-answers-after-servfail';
    assert.deepEqual(judgePlan(ROTATING, sent(plan, [['10.0.0.2', 'sw1', 'A', 1]])), {
      ok: true,
      offset: 1,
    });
    assert.deepEqual(
      judgePlan(
        ROTATING,
        sent(plan, [
          ['10.0.0.1', 'sw1', 'A', 1],
          ['10.0.0.2', 'sw1', 'A', 1],
        ]),
      ),
      { ok: true, offset: 0 },
    );
    const verdict = judgePlan(ROTATING, sent(plan, [['10.0.0.1', 'sw1', 'A', 1]]));
    assert.ok(!verdict.ok);
    assert.match(verdict.problem, /expects one of/u);
  });

  it('refuses a plan the row does not have', () => {
    assert.deepEqual(judgePlan(ONE, sent('servfail', [])), {
      ok: false,
      problem: 'the row has no plan servfail',
    });
  });
});

describe('the differential: every image’s run against the rows', () => {
  it('records each plan of each row in each image that replays it, and skips one off there', () => {
    const runs = [faithful(RESOLV_ROWS, 'debian12'), faithful(RESOLV_ROWS, 'ubuntu2404')];
    const verified = verify(RESOLV_ROWS, runs);
    assert.deepEqual(verified.problems, []);
    assert.deepEqual(verified.counts, {
      debian12: { rows: 1, plans: 2 },
      ubuntu2404: { rows: 2, plans: 3 },
    });
    assert.deepEqual(
      verified.recordings.map((r) => [r.image, r.id, r.plan, r.offset, r.ms]),
      [
        ['debian12', ROW.id, 'nxdomain', undefined, 3],
        ['debian12', ROW.id, 'answer', undefined, 3],
        ['ubuntu2404', ROW.id, 'nxdomain', undefined, 3],
        ['ubuntu2404', ROW.id, 'answer', undefined, 3],
        ['ubuntu2404', 'bbbbbbbbbbbbbbbb', 'last-answers-after-servfail', 0, 3],
      ],
    );
    const file = recordingsFile(runs, verified);
    assert.equal(file.schema, 3);
    // Every answer row in each image, with glibc's OPT records.
    assert.equal(file.answerRecordings.length, 2 * ANSWER_ROWS.length);
    assert.ok(file.recordings.every((r) => Array.isArray(r.opt) && r.opt.length === r.wire.length));
    assert.deepEqual(file.images['ubuntu2404'], {
      base: 'base-of-ubuntu2404',
      digest: 'sha256:0',
      glibc: '2.39',
      node: 'v24.19.0',
      resolved: true,
      rowsDigest: 'r0',
      policyDigest: 'p0',
      answerRowsDigest: 'a0',
    });
  });

  it('keeps what resolved asked upstream with the recording', () => {
    const up: Wire[] = [['127.0.0.2', 'sw1', 'A', 1]];
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const through = {
      ...other,
      rows: other.rows.map((row) => ({
        ...row,
        plans: row.plans.map((plan) => ({ ...plan, upstream: up })),
      })),
    };
    const verified = verify(RESOLV_ROWS, [faithful(RESOLV_ROWS, 'debian12'), through]);
    assert.deepEqual(verified.problems, []);
    const recorded = verified.recordings.filter((r) => r.image === 'ubuntu2404');
    assert.ok(recorded.length > 0 && recorded.every((r) => r.upstream === up));
    assert.ok(verified.recordings.every((r) => r.image === 'ubuntu2404' || !('upstream' in r)));
  });

  it('fails a run of other rows, or of another build of the policy: a run kept from before a change', () => {
    const runs = [faithful(RESOLV_ROWS, 'debian12'), faithful(RESOLV_ROWS, 'ubuntu2404')];
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, rowsDigest: 'r1' }).problems, [
      'debian12: replayed rows r0, the rows file is r1',
      'ubuntu2404: replayed rows r0, the rows file is r1',
    ]);
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, policyDigest: 'p1' }).problems, [
      'debian12: loaded the policy build p0, the build is p1',
      'ubuntu2404: loaded the policy build p0, the build is p1',
    ]);
    // Other answer rows, another build of what the boxes load, or a build that changed under it.
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, answerRowsDigest: 'a1' }).problems, [
      'debian12: played answer rows a0, the answer rows are a1',
      'ubuntu2404: played answer rows a0, the answer rows are a1',
    ]);
    assert.deepEqual(verifyAt(RESOLV_ROWS, runs, { ...CURRENT, buildDigest: 'b1' }).problems, [
      'debian12: ran the build b0, the build is b1',
      'ubuntu2404: ran the build b0, the build is b1',
    ]);
    const [debian, ubuntu] = runs;
    assert.ok(debian !== undefined && ubuntu !== undefined);
    assert.deepEqual(
      verify(RESOLV_ROWS, [{ ...debian, rebuilt: 'before row bbbbbbbbbbbbbbbb' }, ubuntu]).problems,
      ['debian12: its build changed while it ran (before row bbbbbbbbbbbbbbbb)'],
    );
    // A run from before runs said what they ran.
    const [first, second] = runs;
    assert.ok(first !== undefined && second !== undefined);
    const unsaid: Record<string, unknown> = { ...first };
    delete unsaid['rowsDigest'];
    delete unsaid['policyDigest'];
    assert.deepEqual(verify(RESOLV_ROWS, [unsaid as unknown as ImageRun, second]).problems, [
      'debian12: replayed rows undefined, the rows file is r0',
      'debian12: loaded the policy build undefined, the build is p0',
    ]);
  });

  it('fails a row played that the rows do not replay in that image, or that is no row', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const offThere = other.rows.find((row) => row.id === 'bbbbbbbbbbbbbbbb');
    assert.ok(offThere !== undefined);
    assert.deepEqual(
      verify(RESOLV_ROWS, [{ ...good, rows: [...good.rows, offThere] }, other]).problems,
      ['debian12, row bbbbbbbbbbbbbbbb (a walked name): played, and not replayed there'],
    );
    const stray = { ...offThere, id: 'cccccccccccccccc' };
    assert.deepEqual(
      verify(RESOLV_ROWS, [{ ...good, rows: [...good.rows, stray] }, other]).problems,
      ['debian12, row cccccccccccccccc: played, and is no row'],
    );
  });

  it('fails an image whose stub rows go through systemd-resolved where the run did not see it', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    assert.deepEqual(verify(RESOLV_ROWS, [good, { ...other, resolved: false }]).problems, [
      'ubuntu2404: systemd-resolved was not seen to serve the stub rows',
    ]);
    assert.deepEqual(verify(RESOLV_ROWS, [{ ...good, resolved: false }, other]).problems, []);
  });

  it('fails an image not run, run twice, or not one of the rows’, and a glibc not the one stated', () => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    assert.deepEqual(verify(RESOLV_ROWS, [good]).problems, ['ubuntu2404: not run']);
    assert.deepEqual(verify(RESOLV_ROWS, [good, other, other]).problems, [
      'ubuntu2404: run 2 times',
    ]);
    assert.deepEqual(verify(RESOLV_ROWS, [good, other, { ...good, image: 'alpine' }]).problems, [
      'alpine is no image the rows are replayed in',
    ]);
    assert.deepEqual(
      verify(RESOLV_ROWS, [faithful(RESOLV_ROWS, 'debian12', '2.35'), other]).problems,
      ['debian12: runs glibc 2.35, the rows state 2.36'],
    );
  });

  it('fails a row not replayed, a plan not played or played extra, a world not set up, a misread', () => {
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const at = `debian12, row ${ROW.id} (${ROW.title})`;
    const changed = (change: (row: RowRun) => RowRun | undefined): string[] => {
      const good = faithful(RESOLV_ROWS, 'debian12');
      const rows = good.rows.map(change).filter((row) => row !== undefined);
      return verify(RESOLV_ROWS, [{ ...good, rows }, other]).problems;
    };
    assert.deepEqual(
      changed(() => undefined),
      [`${at}: not replayed`],
    );
    assert.deepEqual(
      changed((row) => ({ ...row, plans: row.plans.slice(1) })),
      [`${at}: plan nxdomain not played`],
    );
    assert.deepEqual(
      changed((row) => ({
        ...row,
        plans: [...row.plans, { plan: 'refused', wire: [], outcome: 'x', ms: 1 }],
      })),
      [`${at}: played refused, which the row has no plan for`],
    );
    const unset = changed((row) => ({ ...row, setup: ['could not set /etc/hosts up: EBUSY'] }));
    assert.deepEqual(unset, [`${at}: could not set /etc/hosts up: EBUSY`]);
    assert.deepEqual(
      changed((row) => ({ ...row, inImage: { class: 'off', off: 'nscd: running' } })),
      [`${at}: the check is off in the image: nscd: running`],
    );
    assert.match(
      changed((row) => ({
        ...row,
        plans: row.plans.map((p) => ({ ...p, wire: p.wire.slice(0, 1) })),
      })).join('\n'),
      /nxdomain: the policy expects .*\n.*answer: the policy expects/u,
    );
  });

  it('records nothing for a row whose world was not set up or which the policy misread', () => {
    const other = faithful(RESOLV_ROWS, 'ubuntu2404');
    const good = faithful(RESOLV_ROWS, 'debian12');
    const unset = { ...good, rows: good.rows.map((row) => ({ ...row, setup: ['no'] })) };
    const misread = {
      ...good,
      rows: good.rows.map((row) => ({ ...row, inImage: { ...row.inImage, rotate: true } })),
    };
    for (const run of [unset, misread]) {
      const verified = verify(RESOLV_ROWS, [run, other]);
      assert.equal(verified.counts['debian12']?.plans, 0);
      assert.ok(verified.recordings.every((r) => r.image !== 'debian12'));
    }
  });

  it('S4’s committed rows verify, every image and plan, against a glibc that did what they say', () => {
    const runs = Object.keys(ROWS.images).map((image) => faithful(ROWS, image));
    const verified = verify(ROWS, runs);
    assert.deepEqual(verified.problems, []);
    assert.ok(ROWS.rows.length >= 255, String(ROWS.rows.length));
    assert.deepEqual(ROWS.resolved, ['ubuntu2404']);
    // No committed row is one the replay cannot play: no IP literal, no stub beside another server.
    for (const row of ROWS.rows) {
      const resolv = row.world.files['/etc/resolv.conf'];
      const named = nameserversOf(resolv === undefined ? '' : (ROWS.texts[resolv] ?? ''));
      assert.equal(unplayable(row.question.name, named, true), undefined, row.title);
    }
    const plans = ROWS.rows.reduce((sum, row) => sum + row.expect.plans.length, 0);
    assert.ok(plans >= 400, String(plans));
    assert.equal(verified.counts['debian11']?.rows, ROWS.rows.length);
    // A row not replayed in an image (a name beginning with - at 2.28) owes it no run.
    const dash = ROWS.rows.find(
      (row) => row.question.name === '-dash' && row.question.family === 4,
    );
    assert.ok(dash !== undefined);
    const rocky8 = runs.find((run) => run.image === 'rocky8');
    assert.equal(
      rocky8?.rows.find((row) => row.id === dash.id),
      undefined,
    );
    assert.equal(verified.counts['rocky8']?.rows, ROWS.rows.length - 9);
    // A local row recorded with a question fails.
    const local = ROWS.rows.find((row) => row.expect.class === 'local');
    assert.ok(local !== undefined);
    const broken = runs.map((run) =>
      run.image !== 'debian12'
        ? run
        : {
            ...run,
            rows: run.rows.map((row) =>
              row.id !== local.id
                ? row
                : {
                    ...row,
                    plans: row.plans.map((p) => ({
                      ...p,
                      wire: [['10.0.0.53', local.question.name, 'A', 1] as Wire],
                    })),
                  },
            ),
          },
    );
    assert.equal(verify(ROWS, broken).problems.length, 1);
  });
});

describe('the differential: setting a world’s servers up', () => {
  it('writes a server as the policy does, an IPv4-mapped one in hex', () => {
    assert.equal(canonicalAddress('10.0.0.53'), '10.0.0.53');
    assert.equal(canonicalAddress('2001:DB8:0:0:0:0:0:1'), '2001:db8::1');
    assert.equal(canonicalAddress('::ffff:10.0.0.1'), '::ffff:a00:1');
    assert.equal(canonicalAddress('fe80::1%eth0'), undefined);
    assert.equal(canonicalAddress('10.1'), undefined);
  });

  it('names every server a resolv.conf names, past the 3 glibc asks, once each', () => {
    assert.deepEqual(
      nameserversOf(
        'nameserver 10.0.0.1\nnameserver 10.0.0.2\n# nameserver 10.0.0.9\nnameserver 10.0.0.3\n' +
          'nameserver 10.0.0.4\nnameserver 10.0.0.1\nnameserver\t::ffff:10.0.0.7 \n',
      ),
      ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '::ffff:a00:7'],
    );
    // Every server any row names is one a simulator can stand for.
    for (const row of ROWS.rows) {
      const id = row.world.files['/etc/resolv.conf'];
      const named = nameserversOf(id === undefined ? '' : (ROWS.texts[id] ?? ''));
      for (const server of row.world.addresses) assert.ok(named.includes(server), row.title);
    }
  });

  it('listens for an IPv4-mapped server on its IPv4 address, and for IPv6 on the address', () => {
    assert.deepEqual(listenerOf('10.0.0.53'), { v4: '10.0.0.53' });
    assert.deepEqual(listenerOf('::ffff:a00:1'), { v4: '10.0.0.1' });
    assert.deepEqual(listenerOf('::ffff:c000:2ff'), { v4: '192.0.2.255' });
    assert.deepEqual(listenerOf('2001:db8::1'), { v6: '2001:db8::1' });
    assert.deepEqual(listenerOf('::1'), { v6: '::1' });
  });
});

/** A pcap file of these packets, as tcpdump `-w` writes it on Linux's `lo` (Ethernet). */
function pcap(packets: readonly Buffer[], linkType = 1, header: Buffer = Buffer.alloc(14)): Buffer {
  const global = Buffer.alloc(24);
  global.writeUInt32LE(0xa1b2c3d4, 0);
  global.writeUInt16LE(2, 4);
  global.writeUInt16LE(4, 6);
  global.writeUInt32LE(262_144, 16);
  global.writeUInt32LE(linkType, 20);
  const records = packets.map((ip) => {
    const frame = Buffer.concat([header, ip]);
    const record = Buffer.alloc(16);
    record.writeUInt32LE(frame.length, 8);
    record.writeUInt32LE(frame.length, 12);
    return Buffer.concat([record, frame]);
  });
  return Buffer.concat([global, ...records]);
}

function dnsMessage(name: string, type: number, response = false): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(response ? 0x8180 : 0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels = name
    .split('.')
    .filter((label) => label !== '')
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}

function udp(dstPort: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16BE(40_000, 0);
  header.writeUInt16BE(dstPort, 2);
  header.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([header, payload]);
}

function ipv4(dst: readonly number[], payload: Buffer, protocol = 17): Buffer {
  const header = Buffer.alloc(20);
  header[0] = 0x45;
  header[9] = protocol;
  Buffer.from([127, 0, 0, 1]).copy(header, 12);
  Buffer.from(dst).copy(header, 16);
  return Buffer.concat([header, payload]);
}

function ipv6(dst: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(40);
  header[0] = 0x60;
  header[6] = 17;
  const groups = dst.split(':');
  for (let k = 0; k < 8; k += 1)
    header.writeUInt16BE(Number.parseInt(groups[k] ?? '0', 16), 24 + 2 * k);
  return Buffer.concat([header, payload]);
}

describe('the differential: what glibc sent the stub, read off a capture', () => {
  it('reads each question to port 53, and nothing else', () => {
    const stub = [127, 0, 0, 53];
    const file = pcap([
      ipv4(stub, udp(53, dnsMessage('sw1', 1))),
      ipv4(stub, udp(53, dnsMessage('sw1', 28))),
      ipv4(stub, udp(53, dnsMessage('sw1', 1, true))),
      ipv4(stub, udp(5353, dnsMessage('sw1', 1))),
      ipv4(stub, udp(53, dnsMessage('sw1', 1)), 6),
      ipv4(stub, udp(53, dnsMessage('sw1.corp.example', 65))),
      ipv6('2001:db8:0:0:0:0:0:1', udp(53, dnsMessage('sw2', 28))),
    ]);
    assert.deepEqual(pcapQuestions(file), [
      { server: '127.0.0.53', qname: 'sw1', qtype: 'A', transport: 'udp', opt: false },
      { server: '127.0.0.53', qname: 'sw1', qtype: 'AAAA', transport: 'udp', opt: false },
      {
        server: '127.0.0.53',
        qname: 'sw1.corp.example',
        qtype: 'TYPE65',
        transport: 'udp',
        opt: false,
      },
      { server: '2001:db8::1', qname: 'sw2', qtype: 'AAAA', transport: 'udp', opt: false },
    ]);
  });

  it('reads Linux cooked captures and raw IP too, and refuses a file that is not pcap', () => {
    const packet = ipv4([127, 0, 0, 53], udp(53, dnsMessage('sw1', 1)));
    const want = [{ server: '127.0.0.53', qname: 'sw1', qtype: 'A', transport: 'udp', opt: false }];
    assert.deepEqual(pcapQuestions(pcap([packet], 113, Buffer.alloc(16))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 276, Buffer.alloc(20))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 101, Buffer.alloc(0))), want);
    assert.deepEqual(pcapQuestions(pcap([packet], 147)), []);
    assert.throws(() => pcapQuestions(Buffer.alloc(40, 1)), /not a pcap file/u);
  });
});

describe('the differential: through systemd-resolved, and rows it cannot play', () => {
  const up: Wire[] = [['127.0.0.2', 'sw1', 'A', 1]];
  const plan = (wire: Wire[], upstream?: Wire[]): PlanRun => ({
    plan: 'nxdomain',
    wire,
    outcome: 'x',
    ms: 1,
    ...(upstream === undefined ? {} : { upstream }),
  });
  const rowOf = (...plans: PlanRun[]): RowRun => ({
    id: 'aaaaaaaaaaaaaaaa',
    inImage: classified(ONE),
    plans,
  });
  const toStub: Wire[] = [[STUB, 'sw1', 'A', 1]];
  const toServer: Wire[] = [['10.0.0.53', 'sw1', 'A', 1]];

  it('sees resolved serve the stub only where every plan that asked it went upstream', () => {
    assert.equal(resolvedObserved([rowOf(plan(toStub, up))]), true);
    assert.equal(resolvedObserved([rowOf(plan(toStub, up), plan(toStub, []))]), false);
    assert.equal(resolvedObserved([rowOf(plan(toStub))]), false, 'a simulator stood in for it');
    assert.equal(resolvedObserved([rowOf(plan(toServer))]), false, 'no plan asked the stub');
    assert.equal(resolvedObserved([]), false);
    // A plan that asked another server owes no upstream.
    assert.equal(resolvedObserved([rowOf(plan(toStub, up)), rowOf(plan(toServer))]), true);
  });

  it('will not play an IP literal, nor the stub beside another server through resolved', () => {
    assert.match(unplayable('192.0.2.1', ['10.0.0.53'], false) ?? '', /IP literal/u);
    assert.match(unplayable('2001:db8::1', ['10.0.0.53'], false) ?? '', /IP literal/u);
    // The inet_aton forms are no literal to Node: they reach glibc.
    for (const name of ['10.1', '0x7f.1', '1.2.3.256']) {
      assert.equal(unplayable(name, ['10.0.0.53'], false), undefined, name);
    }
    assert.equal(unplayable('sw1', [STUB], true), undefined);
    assert.match(
      unplayable('sw1', [STUB, '10.0.0.1'], true) ?? '',
      /the stub with another server \(127\.0\.0\.53, 10\.0\.0\.1\)/u,
    );
    assert.match(unplayable('sw1', ['10.0.0.1', STUB], true) ?? '', /order across them/u);
    // A simulator standing in for the stub logs it with the rest, in one order.
    assert.equal(unplayable('sw1', [STUB, '10.0.0.1'], false), undefined);
  });
});

const VERIFY = fileURLToPath(new URL('./differential/names-verify.js', import.meta.url));
const POLICY = fileURLToPath(new URL('../src/resolver/system-names.js', import.meta.url));

describe('the differential: the verdict over the files the runs left', () => {
  it('reads a run, and names a file that is none: empty, as a replay that stopped leaves it', () => {
    const run = faithful(RESOLV_ROWS, 'debian12');
    assert.deepEqual(parseRun('/out/debian12.json', JSON.stringify(run)), { run });
    for (const text of ['', '{"image":', 'null', '{}', '{"image":"debian12"}']) {
      const parsed = parseRun('/out/rocky8.json', text);
      assert.ok('problem' in parsed, text);
      assert.match(parsed.problem, /^\/out\/rocky8\.json: not an image's run/u);
    }
    // The boxes beside the images, by their kind.
    const budget = budgetRun('dnsmasq');
    assert.deepEqual(parseRun('/out/budget-dnsmasq.json', JSON.stringify(budget)), { budget });
    const off = JSON.parse(JSON.stringify(offRun('nscd'))) as OffRun;
    assert.deepEqual(parseRun('/out/off-nscd.json', JSON.stringify(off)), { off });
    const notBudget = parseRun('/out/budget.json', '{"kind":"budget"}');
    assert.ok('problem' in notBudget && /not a budget box's run/u.test(notBudget.problem));
    const notOff = parseRun('/out/off.json', '{"kind":"off","case":"nscd"}');
    assert.ok('problem' in notOff && /not an off box's run/u.test(notOff.problem));
  });

  it('judges every run it can read, and fails the one it cannot, with the digests of what it judges by', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-names-verify-'));
    try {
      const rowsPath = join(dir, 'rows.json');
      writeFileSync(rowsPath, JSON.stringify(RESOLV_ROWS));
      const current: Current = {
        rowsDigest: digestOf(readFileSync(rowsPath)),
        policyDigest: digestOf(readFileSync(POLICY)),
        answerRowsDigest: answerRowsDigest(),
        buildDigest: buildDigest(),
      };
      const runOf = (image: string): ImageRun => ({ ...faithful(RESOLV_ROWS, image), ...current });
      const debian = join(dir, 'debian12.json');
      const ubuntu = join(dir, 'ubuntu2404.json');
      writeFileSync(debian, JSON.stringify(runOf('debian12')));
      // Every box beside the images, each as it should be, of the build as it is.
      const built = { buildDigest: current.buildDigest };
      const boxes = [
        ...(['dnsmasq', 'resolved'] as const).map((forwarder) => {
          const path = join(dir, `budget-${forwarder}.json`);
          writeFileSync(path, JSON.stringify({ ...budgetRun(forwarder), ...built }));
          return path;
        }),
        ...(Object.keys(OFF_CASES) as OffCase[]).map((name) => {
          const path = join(dir, `off-${name}.json`);
          writeFileSync(path, JSON.stringify(offRun(name, built)));
          return path;
        }),
      ];
      const verdict = (...runs: string[]): ReturnType<typeof spawnSync> =>
        spawnSync(process.execPath, [VERIFY, rowsPath, ...runs, ...boxes], {
          encoding: 'utf8',
          timeout: 30_000,
        });
      writeFileSync(ubuntu, '');
      const stopped = verdict(debian, ubuntu);
      assert.equal(stopped.status, 1, String(stopped.stderr));
      assert.equal(stopped.stdout, '');
      const said = String(stopped.stderr);
      assert.match(said, /^debian12: 1 rows, 2 plans recorded$/mu);
      assert.match(said, /^DISAGREES .*ubuntu2404\.json: not an image's run/mu);
      assert.match(said, /^DISAGREES ubuntu2404: not run$/mu);
      writeFileSync(ubuntu, JSON.stringify(runOf('ubuntu2404')));
      const passed = verdict(debian, ubuntu);
      assert.equal(passed.status, 0, String(passed.stderr));
      const file = JSON.parse(String(passed.stdout)) as {
        schema: number;
        images: Record<
          string,
          { rowsDigest: string; policyDigest: string; answerRowsDigest: string }
        >;
      };
      assert.equal(file.schema, 3);
      assert.match(
        String(passed.stderr),
        /^budget dnsmasq gate-kill: \d+ distinct questions held at once at most/mu,
      );
      assert.match(
        String(passed.stderr),
        /^off nscd in debian12: check off by nscd .*, route unvouched:off, 0 questions asked$/mu,
      );
      const recorded = file.images['debian12'];
      assert.ok(recorded !== undefined);
      assert.equal(recorded.rowsDigest, current.rowsDigest);
      assert.equal(recorded.policyDigest, current.policyDigest);
      assert.equal(recorded.answerRowsDigest, current.answerRowsDigest);
      // A run of the rows as they were before a change.
      writeFileSync(ubuntu, JSON.stringify({ ...runOf('ubuntu2404'), rowsDigest: 'f'.repeat(64) }));
      const stale = verdict(debian, ubuntu);
      assert.equal(stale.status, 1);
      assert.match(
        String(stale.stderr),
        /^DISAGREES ubuntu2404: replayed rows f{64}, the rows file is /mu,
      );
      // A box of another build, as one left from before a rebuild would be.
      writeFileSync(ubuntu, JSON.stringify(runOf('ubuntu2404')));
      const [first] = boxes;
      assert.ok(first !== undefined);
      writeFileSync(
        first,
        JSON.stringify({ ...budgetRun('dnsmasq'), buildDigest: 'e'.repeat(64) }),
      );
      const old = verdict(debian, ubuntu);
      assert.equal(old.status, 1);
      assert.match(
        String(old.stderr),
        /^DISAGREES budget box dnsmasq: ran the build e{64}, the build is [0-9a-f]{64}$/mu,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the differential: a capture’s process, every wait on it bounded', () => {
  const node = (script: string, stopBoundMs = 2_000): CaptureOptions => ({
    command: process.execPath,
    argv: ['-e', script],
    ready: 'listening on',
    startBoundMs: 10_000,
    stopBoundMs,
    settleMs: 10,
  });
  const LISTENS = "process.stderr.write('listening on lo\\n');";

  it('stops a capture with SIGINT once it is listening', async () => {
    const capture = await within(
      15_000,
      'the capture to start',
      startCapture(
        node(
          `process.on('SIGINT', () => process.exit(0)); ${LISTENS} setTimeout(() => process.exit(0), 8000);`,
        ),
      ),
    );
    await within(5_000, 'the capture to stop', capture.stop());
  });

  it('says at once that a capture ended on its own, rather than wait for an exit already past', async () => {
    const capture = await within(
      15_000,
      'the capture to start',
      startCapture(node(`${LISTENS} setTimeout(() => {}, 20);`)),
    );
    await sleep(500);
    await assert.rejects(
      within(5_000, 'stop to answer', capture.stop()),
      /ended before it was stopped: listening on lo/u,
    );
  });

  it('fails a capture that ends before it listens, and one that will not stop', async () => {
    await assert.rejects(
      within(15_000, 'the start to fail', startCapture(node('process.exit(3);'))),
      /exited before it was ready/u,
    );
    const stubborn = await within(
      15_000,
      'the capture to start',
      startCapture(
        node(
          `process.on('SIGINT', () => {}); ${LISTENS} setTimeout(() => process.exit(0), 8000);`,
          300,
        ),
      ),
    );
    await assert.rejects(
      within(5_000, 'stop to give up', stubborn.stop()),
      /timed out after 300 ms waiting for .* to stop/u,
    );
  });
});

const LIB = fileURLToPath(new URL('../../../../scripts/lib/names-diff.sh', import.meta.url));
const RECORDINGS = fileURLToPath(
  new URL('../../test/fixtures/system-names-recordings.json', import.meta.url),
);

function bash(script: string, ...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('bash', ['-c', `. "$0"; ${script}`, LIB, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout };
}

describe('the differential’s script: the build the boxes load, and the bases they are built on', () => {
  it('refuses a source newer than its build, or not built, in every package the boxes load', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-names-stale-'));
    try {
      let clock = Date.now();
      const tick = (): Date => new Date((clock += 60_000));
      const old = new Date('2026-10-01T00:00:00Z');
      const put = (path: string, when: Date): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), '');
        utimesSync(join(root, path), when, when);
      };
      const pairs = [
        ['probe', 'src/resolver/system-names'],
        ['probe', 'test/differential/names-replay'],
        ['probe', 'test/support/within'],
        ['simulators', 'src/dns-server'],
        ['sensors', 'src/support/system-lookup'],
        ['shared', 'src/index'],
      ] as const;
      for (const [pkg, file] of pairs) {
        put(`packages/${pkg}/${file}.ts`, old);
        put(`packages/${pkg}/dist/${file}.js`, old);
      }
      put('packages/probe/src/types.d.ts', tick());
      const stale = (): { status: number | null; stdout: string } =>
        bash('ms_names_diff_stale "$1"', root);
      assert.deepEqual(stale(), { status: 0, stdout: '' });
      for (const [pkg, file] of pairs) {
        const src = `packages/${pkg}/${file}.ts`;
        const js = `packages/${pkg}/dist/${file}.js`;
        const when = tick();
        utimesSync(join(root, src), when, when);
        assert.deepEqual(stale(), { status: 1, stdout: `${src}\n` }, `${src} edited`);
        // A build that found its text unchanged emits nothing and records that it has seen it.
        put(`packages/${pkg}/dist/tsconfig.tsbuildinfo`, tick());
        assert.deepEqual(stale(), { status: 0, stdout: '' }, `${src} seen by a build`);
        rmSync(join(root, js));
        assert.deepEqual(stale(), { status: 1, stdout: `${src}\n` }, `${js} missing`);
        put(js, tick());
        assert.deepEqual(stale(), { status: 0, stdout: '' }, `${src} built again`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads each image’s recorded digest, and none for another base, image or file', () => {
    const recorded = JSON.parse(readFileSync(RECORDINGS, 'utf8')) as {
      images: Record<string, { base: string; digest: string }>;
    };
    assert.ok(Object.keys(recorded.images).length >= 7);
    for (const [image, { base, digest }] of Object.entries(recorded.images)) {
      assert.match(digest, /^[a-z]+@sha256:[0-9a-f]{64}$/u, image);
      const read = bash('ms_names_diff_recorded "$1" "$2" "$3"', RECORDINGS, image, base);
      assert.deepEqual(read, { status: 0, stdout: `${digest}\n` }, image);
      const moved = bash('ms_names_diff_recorded "$1" "$2" "$3"', RECORDINGS, image, `${base}x`);
      assert.deepEqual(moved, { status: 0, stdout: '' }, `${image} from another base`);
    }
    const none = { status: 0, stdout: '' };
    assert.deepEqual(bash('ms_names_diff_recorded "$1" alpine alpine:3', RECORDINGS), none);
    assert.deepEqual(bash('ms_names_diff_recorded /nowhere.json debian12 debian:bookworm'), none);
  });
});

describe('the differential: a simulator server as a row’s nameserver', () => {
  it('answers a question as the plan says now, though a plan before left it silent', async () => {
    const sim = await within(
      15_000,
      'the DNS simulator to bind',
      DnsSimulator.start({ servers: [{ ...NAMESERVER, name: 'ns' }], ipv6: false }),
    );
    try {
      const ask = (): ReturnType<typeof dnsQuery> =>
        dnsQuery(sim.target('ns'), 'sw1', 'A', { timeoutMs: 1_000, avoid: sim.ports });
      await sim.set({ fallback: true }, { reply: replies.silent }, 'ns');
      assert.equal((await within(5_000, 'the silent question', ask())).kind, 'timeout');
      // The next plan: the same question, answered, as glibc's next lookup asks it.
      await sim.set({ fallback: true }, { reply: replies.addresses('192.0.2.53') }, 'ns');
      const answered = await within(5_000, 'the answered question', ask());
      assert.equal(answered.kind, 'reply', JSON.stringify(answered));
    } finally {
      await sim.stop();
    }
  });
});

// --- P-460: the walk's wire beside glibc's, the regressions, the answer rows, the budget boxes --

const W = (server: string, name: string, type: string, tries = 1): Wire => [
  server,
  name,
  type,
  tries,
];
const S1 = '10.0.0.53';
const S2 = '10.0.0.54';
const TWO: Classification = {
  class: 'walk',
  candidates: ['sw1.corp.example', 'sw1'],
  types: ['A', 'AAAA'],
  servers: [S1, S2],
  rotate: false,
  timeout: 5,
  attempts: 2,
};

/** A plan glibc played, with the walk and the regression beside it. */
function played(
  wire: readonly Wire[],
  ms: number,
  walk: Partial<WalkRun> & Pick<WalkRun, 'route' | 'wire'>,
  more: Partial<PlanRun> = {},
): PlanRun {
  return {
    plan: 'p',
    wire,
    opt: wire.map(() => false),
    outcome: ms < WITHIN_MS ? 'answer:1' : 'EAI_AGAIN',
    ms,
    walk: { opt: walk.wire.map(() => false), ms: 2, ...walk },
    modes: modesFor(walk.route),
    ...more,
  };
}

describe('P-460: a wire read as its first asks', () => {
  it('asks each question once, at its first try, whatever the transport, its name in lower case', () => {
    assert.deepEqual(
      firstAsks([
        W(S1, 'SW1.Corp', 'A'),
        W(S1, 'sw1.corp', 'AAAA'),
        W(S1, 'sw1.corp', 'A', 2),
        W(`${S1}/tcp`, 'sw1.corp', 'AAAA'),
        W(S2, 'sw1.corp', 'A'),
      ]),
      [`${S1} sw1.corp A`, `${S1} sw1.corp AAAA`, `${S2} sw1.corp A`],
    );
  });
});

describe('P-460: the walk’s wire held to glibc’s', () => {
  const both = (server: string, name: string, tries = 1): Wire[] => [
    W(server, name, 'A', tries),
    W(server, name, 'AAAA', tries),
  ];
  const nx = [...both(S1, 'sw1.corp.example'), ...both(S1, 'sw1')];

  it('a heard walk asked what glibc asked first, in order, and glibc returned within 1 s', () => {
    assert.deepEqual(walkProblems(TWO, played(nx, 4, { route: 'heard', wire: nx })), []);
    // glibc's tries and its TCP retry after TC are its own: the walk asked each question once.
    const retried = [...both(S1, 'sw1.corp.example'), ...both(`${S1}/tcp`, 'sw1.corp.example')];
    assert.deepEqual(
      walkProblems(TWO, played(retried, 4, { route: 'heard', wire: both(S1, 'sw1.corp.example') })),
      [],
    );
    for (const wire of [nx.slice(0, 2), [...nx, W(S2, 'sw1', 'A')], [nx[1], nx[0], nx[2], nx[3]]]) {
      const said = walkProblems(TWO, played(nx, 4, { route: 'heard', wire: wire as Wire[] }));
      assert.equal(said.length, 1, JSON.stringify(wire));
      assert.match(said[0] ?? '', /^p, the walk: heard after asking .* where glibc asked/u);
    }
  });

  it('a silent walk stopped at a question glibc asked too: a prefix of glibc’s, never nothing', () => {
    const glibc = [
      ...both(S1, 'sw1.corp.example'),
      ...both(S2, 'sw1.corp.example'),
      ...both(S1, 'sw1.corp.example', 2),
    ];
    const silent = (wire: Wire[]): string[] =>
      walkProblems(TWO, played(glibc, 8_000, { route: 'silent', wire }));
    assert.deepEqual(silent([W(S1, 'sw1.corp.example', 'A')]), []);
    assert.deepEqual(silent(both(S1, 'sw1.corp.example')), []);
    assert.match(
      silent([W(S2, 'sw1.corp.example', 'A')])[0] ?? '',
      /silent after asking .* not how glibc began/u,
    );
    assert.match(silent([W(S1, 'sw1', 'A')])[0] ?? '', /not how glibc began/u);
    assert.deepEqual(silent([]), ['p, the walk: asked nothing']);
  });

  it('heard if and only if glibc returned within 1 s', () => {
    assert.deepEqual(
      walkProblems(TWO, played(nx, WITHIN_MS - 1, { route: 'heard', wire: nx })),
      [],
    );
    assert.match(
      walkProblems(TWO, played(nx, WITHIN_MS, { route: 'heard', wire: nx })).join(''),
      /^p, the walk: heard, and glibc returned in 1000 ms \(EAI_AGAIN\)$/u,
    );
    const first = [W(S1, 'sw1.corp.example', 'A')];
    assert.match(
      walkProblems(TWO, played(nx, 4, { route: 'silent', wire: first })).join(''),
      /^p, the walk: silent, and glibc returned in 4 ms/u,
    );
  });

  it('never asks a question again over UDP, and is routed by its walk', () => {
    const again = [...nx, W(S1, 'sw1', 'A', 2)];
    assert.match(
      walkProblems(TWO, played(nx, 4, { route: 'heard', wire: again })).join('\n'),
      /asked a question again: \[\["10\.0\.0\.53","sw1","A",2\]\]/u,
    );
    for (const route of ['unvouched:unproven', 'sampled', 'local']) {
      assert.deepEqual(walkProblems(TWO, played(nx, 4, { route, wire: [] })), [
        `p, the walk: routed ${route}, not by a walk`,
      ]);
    }
  });

  it('a local name is routed local with nothing asked', () => {
    const local: Classification = { ...TWO, class: 'local', via: 'hosts' };
    assert.deepEqual(walkProblems(local, played([], 1, { route: 'local', wire: [] })), []);
    assert.deepEqual(
      walkProblems(local, played([], 1, { route: 'heard', wire: [W(S1, 'printer', 'A')] })),
      [
        'p, the walk: routed heard, and the row is local',
        'p, the walk: asked [["10.0.0.53","printer","A",1]] for a name glibc answers unasked',
      ],
    );
  });

  it('says so when the walk was not recorded', () => {
    const { walk: _walk, ...without } = played(nx, 4, { route: 'heard', wire: nx });
    assert.deepEqual(walkProblems(TWO, without), ['p: the walk was not recorded']);
  });

  it('under rotate asks every server at once, glibc’s names in order, of no server the row does not name', () => {
    const rotating: Classification = { ...TWO, rotate: true, types: ['A'] };
    const glibc = [W(S2, 'sw1.corp.example', 'A'), W(S1, 'sw1', 'A')];
    const every = [
      W(S1, 'sw1.corp.example', 'A'),
      W(S2, 'sw1.corp.example', 'A'),
      W(S2, 'sw1', 'A'),
      W(S1, 'sw1', 'A'),
    ];
    assert.deepEqual(walkProblems(rotating, played(glibc, 4, { route: 'heard', wire: every })), []);
    assert.match(
      walkProblems(rotating, played(glibc, 4, { route: 'heard', wire: every.slice(1) })).join(''),
      /asked sw1\.corp\.example A of 1 of 2 servers under rotate, not of 10\.0\.0\.53/u,
    );
    assert.match(
      walkProblems(
        rotating,
        played(glibc, 4, {
          route: 'heard',
          wire: [every[2], every[3], every[0], every[1]] as Wire[],
        }),
      ).join(''),
      /asked the names \["sw1","sw1\.corp\.example"\], where glibc asked/u,
    );
    assert.match(
      walkProblems(
        rotating,
        played(glibc, 4, { route: 'heard', wire: [...every, W('10.0.0.99', 'sw1', 'A')] }),
      ).join(''),
      /of a server the row does not name/u,
    );
    // Heard, its names are all of glibc's: heard after the first name is not how glibc ended.
    assert.match(
      walkProblems(rotating, played(glibc, 4, { route: 'heard', wire: every.slice(0, 2) })).join(
        '',
      ),
      /asked the names \["sw1\.corp\.example"\], where glibc asked \["sw1\.corp\.example","sw1"\]/u,
    );
  });

  describe('under rotate, the plan decides whether the walk is heard', () => {
    const rotating: Classification = { ...TWO, rotate: true, types: ['A'] };
    const glibc = [W(S2, 'sw1.corp.example', 'A'), W(S1, 'sw1', 'A')];
    const every = [
      W(S1, 'sw1.corp.example', 'A'),
      W(S2, 'sw1.corp.example', 'A'),
      W(S2, 'sw1', 'A'),
      W(S1, 'sw1', 'A'),
    ];
    const answering: Pick<Plan, 'answers'> = {
      answers: { [S1]: { A: 'nxdomain' }, [S2]: { A: 'nxdomain' } },
    };
    const oneSilent: Pick<Plan, 'answers'> = {
      answers: { [S1]: { A: 'silent' }, [S2]: { A: 'address' } },
    };
    const walk = (
      route: 'heard' | 'silent',
      ms: number,
      plan: Pick<Plan, 'answers'> | undefined,
    ): string[] =>
      walkProblems(
        rotating,
        played(ms < WITHIN_MS ? glibc : glibc.slice(0, 1), ms, {
          route,
          wire:
            route === 'heard' ? (ms < WITHIN_MS ? every : every.slice(0, 2)) : every.slice(0, 2),
        }),
        { plan },
      );

    it('with every server answering, heard if and only if glibc returned within 1 s', () => {
      assert.deepEqual(walk('heard', 4, answering), []);
      // A walk routed silent though every server answered, glibc back in 4 ms: no exception.
      assert.deepEqual(walk('silent', 4, answering), [
        'p, the walk: silent, and glibc returned in 4 ms (answer:1)',
      ]);
      assert.match(
        walk('heard', 5_000, answering).join(''),
        /heard, and glibc returned in 5000 ms/u,
      );
      assert.deepEqual(walk('silent', 5_000, answering), []);
    });

    it('with a server silent, the walk is silent, and glibc’s time says nothing', () => {
      // glibc may start at the one server that answers: a silent walk and a quick glibc agree.
      assert.deepEqual(walk('silent', 4, oneSilent), []);
      assert.deepEqual(walk('silent', 5_000, oneSilent), []);
      for (const ms of [4, 5_000]) {
        assert.match(
          walk('heard', ms, oneSilent).join(''),
          /^p, the walk: heard under rotate, and the plan has 10\.0\.0\.53 A silent/u,
          String(ms),
        );
      }
    });

    it('takes no server for silent that the row does not name, nor to a type glibc does not ask', () => {
      const elsewhere: Pick<Plan, 'answers'> = {
        answers: { [S1]: { A: 'nxdomain', AAAA: 'silent' }, '10.0.0.99': { A: 'silent' } },
      };
      assert.deepEqual(walk('silent', 4, elsewhere), [
        'p, the walk: silent, and glibc returned in 4 ms (answer:1)',
      ]);
    });

    it('without the plan, holds the walk both ways', () => {
      assert.deepEqual(walk('silent', 4, undefined), [
        'p, the walk: silent, and glibc returned in 4 ms (answer:1)',
      ]);
    });

    it('an all-NXDOMAIN plan of a committed rotating row, walked silent with glibc quick, fails', () => {
      const row = ROWS.rows.find((each) => each.expect.rotate && each.expect.servers.length === 3);
      assert.ok(row !== undefined);
      const plan = row.expect.plans.find((each) => each.plan === 'nxdomain');
      assert.ok(plan !== undefined && plan.wireByOffset !== undefined);
      const wire = plan.wireByOffset[0] ?? [];
      const asked = row.expect.servers.map((server): Wire => [server, 'sw1.corp.example', 'A', 1]);
      const said = walkProblems(
        row.expect,
        played(wire, 4, { route: 'silent', wire: asked }, { outcome: 'ENOTFOUND' }),
        { plan },
      );
      assert.deepEqual(said, ['p, the walk: silent, and glibc returned in 4 ms (ENOTFOUND)']);
    });
  });

  describe('under rotate, the walk’s types are glibc’s', () => {
    const rotating: Classification = { ...TWO, servers: [S1, S2], rotate: true };
    // glibc's nxdomain: server 2 for the first name, server 1 for the second, A and AAAA each.
    const glibc = [
      W(S2, 'sw1.corp.example', 'A'),
      W(S2, 'sw1.corp.example', 'AAAA'),
      W(S1, 'sw1', 'A'),
      W(S1, 'sw1', 'AAAA'),
    ];
    const of = (name: string, types: readonly string[]): Wire[] =>
      types.flatMap((type) => [S1, S2].map((server) => W(server, name, type)));
    const both = ['A', 'AAAA'];
    const all = [...of('sw1.corp.example', both), ...of('sw1', both)];
    const heard = (wire: Wire[]): string[] =>
      walkProblems(rotating, played(glibc, 4, { route: 'heard', wire }));
    const silentPlan: Pick<Plan, 'answers'> = {
      answers: { [S1]: { A: 'silent', AAAA: 'silent' }, [S2]: { A: 'address', AAAA: 'address' } },
    };
    const silent = (wire: Wire[], at: readonly Wire[] = glibc): string[] =>
      walkProblems(rotating, played(at, 4, { route: 'silent', wire }), { plan: silentPlan });

    it('a heard walk asked each name of every server with every type glibc asked of it', () => {
      assert.deepEqual(heard(all), []);
      // The AAAA asks dropped, for every name and server.
      assert.match(
        heard(all.filter(([, , type]) => type === 'A')).join(''),
        /^p, the walk: asked sw1\.corp\.example AAAA of 0 of 2 servers under rotate, not of 10\.0\.0\.53, 10\.0\.0\.54$/u,
      );
      // One server's AAAA for the second name dropped.
      assert.match(
        heard(
          all.filter(
            ([server, name, type]) => !(server === S2 && name === 'sw1' && type === 'AAAA'),
          ),
        ).join(''),
        /asked sw1 AAAA of 1 of 2 servers under rotate, not of 10\.0\.0\.54/u,
      );
    });

    it('no walk asks a type glibc did not ask of a name', () => {
      assert.match(
        heard([...all, W(S1, 'sw1', 'TXT')]).join(''),
        /^p, the walk: asked 10\.0\.0\.53 sw1 TXT, and glibc asked sw1 \["A","AAAA"\] only$/u,
      );
      assert.match(
        heard([...all, W(S2, 'sw1', 'TYPE255')]).join(''),
        /asked 10\.0\.0\.54 sw1 TYPE255/u,
      );
      const familyFour: Classification = { ...rotating, types: ['A'] };
      const fourGlibc = glibc.filter(([, , type]) => type === 'A');
      const fourWalk = all.filter(([, , type]) => type === 'A');
      assert.deepEqual(
        walkProblems(familyFour, played(fourGlibc, 4, { route: 'heard', wire: fourWalk })),
        [],
      );
      assert.match(
        walkProblems(
          familyFour,
          played(fourGlibc, 4, { route: 'heard', wire: [...fourWalk, W(S1, 'sw1', 'AAAA')] }),
        ).join(''),
        /asked 10\.0\.0\.53 sw1 AAAA, and glibc asked sw1 \["A"\] only/u,
      );
      assert.match(
        silent([...of('sw1.corp.example', ['A']), W(S2, 'sw1.corp.example', 'TXT')]).join(''),
        /asked 10\.0\.0\.54 sw1\.corp\.example TXT, and glibc asked/u,
      );
    });

    it('a silent walk asked the name it stopped at of every server, glibc’s first type at least', () => {
      const firstName = glibc.slice(0, 2);
      // Run 4's silent walks: A of every server, AAAA only of the one that answered A.
      assert.deepEqual(
        silent([...of('sw1.corp.example', ['A']), W(S2, 'sw1.corp.example', 'AAAA')], firstName),
        [],
      );
      assert.deepEqual(silent(of('sw1.corp.example', ['A']), firstName), []);
      assert.match(
        silent([W(S2, 'sw1.corp.example', 'A'), W(S2, 'sw1.corp.example', 'AAAA')], firstName).join(
          '',
        ),
        /asked sw1\.corp\.example A of 1 of 2 servers under rotate, not of 10\.0\.0\.53/u,
      );
    });

    it('a silent walk asked each name it went past of every server with every type', () => {
      assert.deepEqual(silent([...of('sw1.corp.example', both), ...of('sw1', ['A'])]), []);
      assert.match(
        silent([...of('sw1.corp.example', ['A']), ...of('sw1', ['A'])]).join(''),
        /asked sw1\.corp\.example AAAA of 0 of 2 servers under rotate/u,
      );
    });
  });

  it('P-454’s known limit is asserted as it is: heard, and glibc not within 1 s', () => {
    const wire = [W(S1, 'sw1', 'A'), W(S1, 'sw1', 'AAAA')];
    assert.deepEqual(
      walkProblems(TWO, played(wire, 1_200, { route: 'heard', wire }), { divergence: 'P-454' }),
      [],
    );
    for (const [route, ms] of [
      ['heard', 4],
      ['silent', 1_200],
    ] as const) {
      assert.match(
        walkProblems(TWO, played(wire, ms, { route, wire: wire.slice(0, 1) }), {
          divergence: 'P-454',
        }).join(''),
        /P-454's known limit has moved/u,
      );
    }
  });
});

describe('P-460: the OPT record on each wire, a known limit asserted as it is', () => {
  const wire = [W(S1, 'sw1', 'A'), W(S1, 'sw1', 'AAAA'), W(S1, 'sw1', 'A', 2)];
  const withOpt = (glibc: boolean[], walk: boolean[] = [false]): PlanRun =>
    played(wire, 4, { route: 'heard', wire: wire.slice(0, 1), opt: walk }, { opt: glibc });

  it('glibc’s carry one under options edns0 and none without; the check’s never', () => {
    assert.deepEqual(optProblems(withOpt([true, true, true]), 'every'), []);
    assert.deepEqual(optProblems(withOpt([false, false, false]), 'none'), []);
    assert.match(
      optProblems(withOpt([true, false, true]), 'every').join(''),
      /under options edns0 every one/u,
    );
    assert.match(
      optProblems(withOpt([false, true, false]), 'none').join(''),
      /without options edns0 none/u,
    );
    assert.match(
      optProblems(withOpt([false, false, false], [true]), 'none').join(''),
      /the check’s questions carry an OPT record now, where c-ares 1\.34\.6 sent none: P-454’s known limit has moved/u,
    );
  });

  it('glibc drops EDNS after its first questions where the row says so, and never takes it up again', () => {
    assert.deepEqual(optProblems(withOpt([true, true, false]), 'then-none'), []);
    for (const opt of [
      [true, true, true],
      [false, false, false],
      [true, false, true],
    ]) {
      assert.equal(optProblems(withOpt(opt), 'then-none').length, 1, JSON.stringify(opt));
    }
  });

  it('says so when a wire’s OPT records were not all recorded', () => {
    assert.match(
      optProblems(withOpt([true]), 'every').join(''),
      /glibc’s OPT records were not recorded/u,
    );
    const { opt: _opt, ...none } = withOpt([true, true, true]);
    assert.match(optProblems(none, 'every').join(''), /glibc’s OPT records were not recorded/u);
    assert.match(
      optProblems(withOpt([true, true, true], []), 'every').join(''),
      /the walk’s OPT records were not recorded/u,
    );
  });
});

describe('P-460: the regressions, gate against system and the helper against the lanes', () => {
  const wire = [W(S1, 'sw1', 'A')];
  const with_ = (modes: Partial<ModesRun>, route = 'heard'): PlanRun =>
    played(wire, 4, { route, wire }, { modes: { ...modesFor(route), ...modes } });

  it('agrees when every lookup answered alike and gate mode ran it where its walk said', () => {
    assert.deepEqual(modesProblems(with_({})), []);
    assert.deepEqual(modesProblems(with_({}, 'silent')), []);
    assert.deepEqual(modesProblems(with_({}, 'local')), []);
  });

  it('names an answer that differs, and a lookup run where its walk did not say', () => {
    assert.deepEqual(modesProblems(with_({ gate: 'error:ENOTFOUND' })), [
      `p, regression: gate mode answered error:ENOTFOUND, system mode ${ANSWERED}`,
    ]);
    assert.deepEqual(modesProblems(with_({ helper: 'answer:192.0.2.54' })), [
      `p, regression: the helper’s child answered answer:192.0.2.54, the probe’s lanes ${ANSWERED}`,
    ]);
    assert.deepEqual(modesProblems(with_({ gateRan: 'helper' })), [
      'p, regression: gate mode ran it in the helper, and its walk was heard',
    ]);
    assert.deepEqual(modesProblems(with_({ gateRan: 'lanes' }, 'silent')), [
      'p, regression: gate mode ran it on the probe’s lanes, and its walk was silent',
    ]);
    const { modes: _modes, ...none } = with_({});
    assert.deepEqual(modesProblems(none), ['p: the regression’s lookups were not recorded']);
  });
});

describe('P-460: the answer rows', () => {
  it('each row is one in every image, says how glibc and the walk end, and names P-454 where they part', () => {
    assert.equal(new Set(ANSWER_ROWS.map((row) => row.id)).size, ANSWER_ROWS.length);
    const titles = ANSWER_ROWS.map((row) => row.title).join('\n');
    for (const want of [
      /TC .*TCP\/53 refused/u,
      /TC .*TCP\/53 refused.*edns0/u,
      /^FORMERR/mu,
      /A answered and AAAA SERVFAIL from server 1, server 2 silent/u,
    ]) {
      assert.match(titles, want);
    }
    for (const row of ANSWER_ROWS) {
      assert.ok(row.divergence === undefined || (row.walk === 'heard' && !row.fast), row.id);
      assert.ok(row.divergence !== undefined || (row.walk === 'heard') === row.fast, row.id);
      assert.equal(row.glibcOpt !== 'none', /\bedns0\b/u.test(row.resolvConf), row.id);
      assert.deepEqual(firstAsks(row.wire).length > 0, true, row.id);
      // What getaddrinfo returns, as names-lookup says it: an answer's count, or an error's code.
      assert.match(row.outcome, /^(answer:[1-9]\d*|E[A-Z_]+)$/u, row.id);
    }
    // As run 4 recorded them, and the findings and P-460 state them.
    assert.deepEqual(Object.fromEntries(ANSWER_ROWS.map((row) => [row.id, row.outcome])), {
      'answer-tc-tcp-refused': 'answer:2',
      'answer-tc-tcp-refused-edns0': 'answer:2',
      'answer-formerr': 'ENOTFOUND',
      'answer-aaaa-servfail-second-silent': 'answer:1',
      'answer-edns-formerr-edns0': 'ENOTFOUND',
      'answer-edns-deaf-edns0': 'EAI_AGAIN',
    });
  });

  it('holds when glibc and the walk did what the row says', () => {
    for (const row of ANSWER_ROWS)
      assert.deepEqual(answerProblems(row, faithfulAnswer(row)), [], row.id);
  });

  it('names each way a row can disagree', () => {
    const row = ANSWER_ROWS.find((each) => each.id === 'answer-formerr');
    assert.ok(row !== undefined);
    const good = faithfulAnswer(row);
    const plan = good.plans[0];
    assert.ok(plan !== undefined && plan.walk !== undefined && plan.modes !== undefined);
    const changed = (change: Partial<PlanRun>, run: Partial<RowRun> = {}): string[] =>
      answerProblems(row, { ...good, ...run, plans: [{ ...plan, ...change }] });
    assert.match(
      changed({
        wire: [...plan.wire, W(S2, 'sw1.example.test', 'A')],
        opt: [...(plan.opt ?? []), false],
      }).join('\n'),
      /the row expects .* glibc sent/u,
    );
    assert.match(
      changed({ ms: 2_000 }).join('\n'),
      /glibc returned in 2000 ms .* the row says it returns within 1000 ms/u,
    );
    // The same wire and as quick, and getaddrinfo returned otherwise than the row says.
    assert.deepEqual(changed({ outcome: 'EAI_AGAIN' }), [
      'plan: getaddrinfo returned EAI_AGAIN, and the row says ENOTFOUND',
    ]);
    const lone = ANSWER_ROWS.find((each) => each.id === 'answer-aaaa-servfail-second-silent');
    assert.ok(lone !== undefined);
    const loneRun = faithfulAnswer(lone);
    const lonePlan = loneRun.plans[0];
    assert.ok(lonePlan !== undefined);
    assert.deepEqual(
      answerProblems(lone, { ...loneRun, plans: [{ ...lonePlan, outcome: 'EAI_AGAIN', ms: 10 }] }),
      ['plan: getaddrinfo returned EAI_AGAIN, and the row says answer:1'],
    );
    assert.match(
      changed({ walk: { ...plan.walk, route: 'silent', wire: plan.walk.wire.slice(0, 1) } }).join(
        '\n',
      ),
      /the walk was silent, and the row says heard/u,
    );
    assert.match(
      changed({}, { edns0: true }).join('\n'),
      /reads edns0 as true, the row says false/u,
    );
    assert.match(
      changed({}, { inImage: { class: 'off', off: 'nscd: running' } }).join('\n'),
      /check is off in the image/u,
    );
    assert.deepEqual(answerProblems(row, { ...good, plans: [] }), ['plan plan not played']);
    assert.match(
      answerProblems(row, { ...good, plans: [plan, { ...plan, plan: 'other' }] }).join('\n'),
      /played other, which the row has no plan for/u,
    );
    assert.deepEqual(answerProblems(row, { ...good, setup: ['no'] }).slice(0, 1), ['no']);
    // Its walk, its OPT records and its regression are held as every plan's are.
    assert.match(
      changed({
        walk: { ...plan.walk, wire: [W(S2, 'sw1.example.test', 'A')], opt: [false] },
      }).join('\n'),
      /^plan, the walk: heard after asking .* where glibc asked/mu,
    );
    assert.match(
      changed({ opt: plan.wire.map(() => true) }).join('\n'),
      /^plan: glibc’s questions carried OPT records \[true,true\], and without options edns0/mu,
    );
    assert.match(
      changed({ modes: { ...plan.modes, gate: 'answer:192.0.2.1' } }).join('\n'),
      /^plan, regression: gate mode answered answer:192\.0\.2\.1, system mode/mu,
    );
  });

  it('every image must play every answer row, and only those, and each is recorded', () => {
    const [debian, ubuntu] = [
      faithful(RESOLV_ROWS, 'debian12'),
      faithful(RESOLV_ROWS, 'ubuntu2404'),
    ];
    const first = ANSWER_ROWS[0];
    assert.ok(first !== undefined);
    const missing = { ...debian, answers: (debian.answers ?? []).slice(1) };
    assert.deepEqual(verify(RESOLV_ROWS, [missing, ubuntu]).problems, [
      `debian12, answer row ${first.id} (${first.title}): not replayed`,
    ]);
    const stray = {
      ...debian,
      answers: [...(debian.answers ?? []), { ...faithfulAnswer(first), id: 'answer-none' }],
    };
    assert.deepEqual(verify(RESOLV_ROWS, [stray, ubuntu]).problems, [
      'debian12, answer row answer-none: played, and is no answer row',
    ]);
    const verified = verify(RESOLV_ROWS, [debian, ubuntu]);
    assert.deepEqual(
      verified.answerRecordings.filter((r) => r.image === 'debian12').map((r) => [r.id, r.plan]),
      ANSWER_ROWS.map((row) => [row.id, ANSWER_PLAN]),
    );
    // A row that disagrees records nothing.
    const wrong = {
      ...debian,
      answers: (debian.answers ?? []).map((run) => ({ ...run, edns0: !(run.edns0 ?? false) })),
    };
    assert.equal(
      verifyAt(RESOLV_ROWS, [wrong, ubuntu], CURRENT).answerRecordings.filter(
        (r) => r.image === 'debian12',
      ).length,
      0,
    );
  });
});

describe('P-460: every plan of S4’s rows is held to its walk, its OPT records and its regression', () => {
  const at = `debian12, row ${ROW.id} (${ROW.title})`;
  const changed = (
    change: (plan: PlanRun) => PlanRun,
    run: (row: RowRun) => RowRun = (row) => row,
  ): string[] => {
    const good = faithful(RESOLV_ROWS, 'debian12');
    const rows = good.rows.map((row) =>
      row.id === ROW.id ? run({ ...row, plans: row.plans.map(change) }) : row,
    );
    return verify(RESOLV_ROWS, [{ ...good, rows }, faithful(RESOLV_ROWS, 'ubuntu2404')]).problems;
  };

  it('names a walk that disagrees, an OPT record, a regression and a reading not recorded', () => {
    assert.deepEqual(
      changed((plan) => plan),
      [],
    );
    assert.deepEqual(
      changed((plan) => (plan.plan === 'answer' ? { ...plan, ms: 2_000 } : plan)),
      [`${at}: answer, the walk: heard, and glibc returned in 2000 ms (answer:1)`],
    );
    assert.deepEqual(
      changed((plan) =>
        plan.plan === 'answer' ? { ...plan, opt: plan.wire.map(() => true) } : plan,
      ),
      [
        `${at}: answer: glibc’s questions carried OPT records [true,true], and without options edns0 none of glibc’s questions carries an OPT record`,
      ],
    );
    assert.deepEqual(
      changed((plan) =>
        plan.plan === 'answer'
          ? { ...plan, modes: { ...modesFor('heard'), gate: 'error:EAI_AGAIN' } }
          : plan,
      ),
      [`${at}: answer, regression: gate mode answered error:EAI_AGAIN, system mode ${ANSWERED}`],
    );
    const { edns0: _edns0, ...unsaid } =
      faithful(RESOLV_ROWS, 'debian12').rows[0] ?? ({} as RowRun);
    assert.deepEqual(
      changed(
        (plan) => plan,
        () => unsaid as RowRun,
      ),
      [
        `${at}: whether the policy read options edns0 was not recorded`,
        `${at}: whether the policy read options edns0 was not recorded`,
      ],
    );
  });
});

describe('P-460: a rotating row’s plans, judged with their answers', () => {
  it('lets a silent walk stand beside a quick glibc only where the plan has a server silent', () => {
    const rotating = new Set(ROWS.rows.filter((row) => row.expect.rotate).map((row) => row.id));
    let quickened = 0;
    // As run 4 saw in some images: glibc started at a server that answered, and was back in 8 ms.
    const quick = (image: string, route: string): ImageRun => {
      const run = faithful(ROWS, image);
      return {
        ...run,
        rows: run.rows.map((row) =>
          !rotating.has(row.id)
            ? row
            : {
                ...row,
                plans: row.plans.map((plan) => {
                  if (plan.walk?.route !== route) return plan;
                  quickened += 1;
                  return { ...plan, ms: 8, walk: { ...plan.walk, route: 'silent' } };
                }),
              },
        ),
      };
    };
    const images = Object.keys(ROWS.images);
    assert.deepEqual(
      verify(
        ROWS,
        images.map((image) => quick(image, 'silent')),
      ).problems,
      [],
    );
    assert.ok(quickened >= images.length, String(quickened));
    // A plan every server answers, walked silent and glibc as quick: each one a problem.
    quickened = 0;
    const problems = verify(
      ROWS,
      images.map((image) => quick(image, 'heard')),
    ).problems;
    assert.ok(quickened > 0);
    assert.equal(
      problems.filter((problem) => /, the walk: silent, and glibc returned in 8 ms/u.test(problem))
        .length,
      quickened,
    );
  });
});

/** A budget box's run that holds: system's peak, gate's within 12 of it, the killed one within 28. */
function budgetRun(
  forwarder: 'dnsmasq' | 'resolved',
  arms: Partial<Record<string, Partial<BudgetRun['arms'][number]>>> = {},
): BudgetRun {
  const built = { buildDigest: CURRENT.buildDigest };
  const names =
    forwarder === 'dnsmasq'
      ? (['system', 'gate', 'gate-kill'] as const)
      : (['system', 'gate'] as const);
  return {
    kind: 'budget',
    forwarder,
    image: forwarder === 'dnsmasq' ? 'debian12' : 'ubuntu2404',
    version: 'test',
    names: BUDGET_NAMES,
    family: 0,
    windowMs: 30_000,
    arms: names.map((arm) => ({
      arm,
      lookups: BUDGET_NAMES,
      peakHeld: arm === 'system' ? 8 : 10,
      distinct: 40,
      ...(forwarder === 'dnsmasq' ? { maxReached: 0 } : {}),
      ...(arm === 'system'
        ? {}
        : { checkState: 1, helperLosses: arm === 'gate-kill' ? 1 : 0, questionsPeak: 10 }),
      ...arms[arm],
    })),
    ...built,
  };
}

describe('P-460: the budget boxes', () => {
  it('holds a forwarder below its table, gate within 12 of system, and a helper SIGKILL within the transient', () => {
    assert.equal(BUDGET_FORWARD_MAX, 30);
    assert.equal(BUDGET_NAMES, 150);
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq')), []);
    assert.deepEqual(budgetProblems(budgetRun('resolved')), []);
    const edge = 8 + BUDGET_GATE_EXTRA;
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq', { gate: { peakHeld: edge } })), []);
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq', { gate: { peakHeld: edge + 1 } })), [
      `budget box dnsmasq, gate: held ${String(edge + 1)} distinct questions at once, over ${String(edge)} (system 8)`,
    ]);
    const killed = edge + BUDGET_LOSS_TRANSIENT;
    assert.deepEqual(
      budgetProblems(budgetRun('dnsmasq', { 'gate-kill': { peakHeld: killed } })),
      [],
    );
    assert.equal(
      budgetProblems(budgetRun('dnsmasq', { 'gate-kill': { peakHeld: killed + 1 } })).length,
      1,
    );
    assert.deepEqual(
      budgetProblems(budgetRun('resolved', { gate: { peakHeld: edge + 1 } })).length,
      1,
    );
  });

  it('names a full table, a check not on, a helper not lost, a zone not asked, an arm not run', () => {
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq', { system: { maxReached: 3 } })), [
      'budget box dnsmasq, system: dnsmasq said its forward table was full 3 times',
    ]);
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq', { gate: { checkState: 3 } })), [
      'budget box dnsmasq, gate: the check was not on and proven (nameCheckState 3)',
    ]);
    assert.deepEqual(budgetProblems(budgetRun('dnsmasq', { 'gate-kill': { helperLosses: 0 } })), [
      'budget box dnsmasq, gate-kill: the helper was not lost',
    ]);
    assert.match(
      budgetProblems(budgetRun('dnsmasq', { system: { peakHeld: 1 } })).join('\n'),
      /system held 1 questions at its most: the silent zone was not asked/u,
    );
    const run = budgetRun('dnsmasq');
    assert.deepEqual(budgetProblems({ ...run, arms: run.arms.slice(0, 2) }), [
      'budget box dnsmasq: the gate-kill arm did not run',
    ]);
    assert.match(
      budgetProblems({ ...run, names: 10 }).join(''),
      /asked 10 names for family 0, not 150/u,
    );
    assert.deepEqual(budgetProblems({ ...run, setup: ['dnsmasq did not start'] }), [
      'budget box dnsmasq: dnsmasq did not start',
    ]);
    const { maxReached: _max, ...unsaid } = run.arms[0] ?? ({} as BudgetRun['arms'][number]);
    assert.match(
      budgetProblems({ ...run, arms: [unsaid, ...run.arms.slice(1)] }).join(''),
      /full an unknown number of times/u,
    );
  });
});

/** A box with the check off as its case says. */
function offRun(name: OffCase, change: Partial<OffRun> = {}): OffRun {
  const claim = OFF_CASES[name];
  return {
    kind: 'off',
    case: name,
    image: claim.image,
    check: 'off',
    off: {
      code: claim.code,
      why: {
        nscd: 'nscd is running (/var/run/nscd/socket)',
        resolve: 'nsswitch.conf’s hosts: line has an action group',
        mdns4_minimal: 'nsswitch.conf’s hosts: line has an action group',
        'ld-preload':
          'LD_PRELOAD is set in ms-probe’s environment: what ld.so loads with it may answer for glibc',
        'ld-so-preload': '/etc/ld.so.preload is not empty: ld.so loads what it names',
      }[name],
    },
    hostsLine: {
      nscd: 'files dns',
      resolve: 'files resolve [!UNAVAIL=return] dns',
      mdns4_minimal: 'files mdns4_minimal [NOTFOUND=return] dns',
      'ld-preload': 'files dns',
      'ld-so-preload': 'files dns',
    }[name],
    nscdSocket: name === 'nscd',
    ldPreload: name === 'ld-preload' ? '/usr/lib/aarch64-linux-gnu/libresolv.so.2' : undefined,
    ldSoPreload:
      name === 'ld-so-preload' ? '/usr/lib/aarch64-linux-gnu/libresolv.so.2\n' : undefined,
    route: 'unvouched:off',
    asked: [],
    buildDigest: CURRENT.buildDigest,
    ...change,
  };
}

describe('P-461: the boxes with the check off in situ', () => {
  it('holds each box that is as its case says, with the check off by its rule', () => {
    for (const name of Object.keys(OFF_CASES) as OffCase[])
      assert.deepEqual(offProblems(offRun(name)), [], name);
  });

  it('fails a box with the check on, off by another rule, not in situ, or routing a name otherwise', () => {
    const { off: _off, ...on } = offRun('nscd');
    assert.deepEqual(offProblems({ ...on, check: 'on' }), [
      'off box nscd: the policy loaded in the box has the check on',
    ]);
    assert.deepEqual(offProblems(offRun('nscd', { check: 'on' })), [
      'off box nscd: the policy loaded in the box has the check on',
    ]);
    assert.deepEqual(
      offProblems(offRun('nscd', { off: { code: 'module', why: 'nscd is running' } })),
      ['off box nscd: the policy has the check off by module (nscd is running), not by nscd'],
    );
    assert.equal(
      offProblems(offRun('ld-preload', { off: { code: 'env', why: 'LOCALDOMAIN is set' } })).length,
      1,
    );
    assert.deepEqual(offProblems(offRun('nscd', { nscdSocket: false })), [
      'off box nscd: nscd’s socket is not there: nscd is not running',
    ]);
    assert.deepEqual(offProblems(offRun('resolve', { hostsLine: 'files dns' })), [
      'off box resolve: the box’s hosts: line is "files dns", with no resolve [!UNAVAIL=return]',
    ]);
    assert.deepEqual(offProblems(offRun('mdns4_minimal', { hostsLine: undefined })), [
      'off box mdns4_minimal: the box’s hosts: line is undefined, with no mdns4_minimal',
    ]);
    assert.deepEqual(offProblems(offRun('ld-preload', { ldPreload: '' })), [
      'off box ld-preload: LD_PRELOAD is not set in the box',
    ]);
    assert.deepEqual(offProblems(offRun('ld-so-preload', { ldSoPreload: undefined })), [
      'off box ld-so-preload: /etc/ld.so.preload is empty or absent in the box',
    ]);
    assert.deepEqual(offProblems(offRun('nscd', { route: 'heard' })), [
      'off box nscd: the check routed a name heard, not unvouched:off',
    ]);
    // Its canary, or any question, from its start to its stop: the check is off and asks nothing.
    assert.deepEqual(offProblems(offRun('nscd', { asked: ['127.0.0.1 localhost. A'] })), [
      'off box nscd: the check asked 127.0.0.1 localhost. A, with the check off',
    ]);
    const { asked: _asked, ...unrecorded } = offRun('ld-preload');
    assert.deepEqual(offProblems(unrecorded as OffRun), [
      'off box ld-preload: what the check asked was not recorded',
    ]);
    assert.deepEqual(offProblems(offRun('nscd', { image: 'rocky9' })), [
      'off box nscd: ran in rocky9, not debian12',
    ]);
    assert.deepEqual(offProblems(offRun('nscd', { setup: ['nscd did not start'] })).slice(0, 1), [
      'off box nscd: nscd did not start',
    ]);
  });

  it('every box is run once, and none other', () => {
    const budget = [budgetRun('dnsmasq'), budgetRun('resolved')];
    const off = (Object.keys(OFF_CASES) as OffCase[]).map((name) => offRun(name));
    const verifyBoxes = (b: readonly BudgetRun[], o: readonly OffRun[]): string[] =>
      verifyBoxesAt(b, o, CURRENT);
    assert.deepEqual(verifyBoxes(budget, off), []);
    assert.deepEqual(verifyBoxes(budget.slice(1), off.slice(1)), [
      'budget box dnsmasq: not run',
      'off box nscd: not run',
    ]);
    assert.deepEqual(verifyBoxes([...budget, budgetRun('resolved')], [...off, offRun('nscd')]), [
      'budget box resolved: run 2 times',
      'off box nscd: run 2 times',
    ]);
    assert.deepEqual(
      verifyBoxes(
        [...budget, { ...budgetRun('resolved'), forwarder: 'unbound' as 'resolved' }],
        off,
      ).slice(-1),
      ['budget box unbound: no such box'],
    );
    assert.deepEqual(
      verifyBoxes(budget, [...off, { ...offRun('nscd'), case: 'sss' as OffCase }]).slice(-1),
      ['off box sss: no such box'],
    );
    // Each box of the build the verdict judges by, and unchanged while it ran.
    assert.deepEqual(
      verifyBoxesAt(budget, off, { buildDigest: 'b1' }).length,
      budget.length + off.length,
    );
    assert.deepEqual(
      verifyBoxes([{ ...budgetRun('dnsmasq'), buildDigest: 'b9' }, budgetRun('resolved')], off),
      ['budget box dnsmasq: ran the build b9, the build is b0'],
    );
    assert.deepEqual(
      verifyBoxes(budget, [offRun('nscd', { rebuilt: 'at the end' }), ...off.slice(1)]),
      ['off box nscd: its build changed while it ran (at the end)'],
    );
  });
});

describe('P-460: an OPT record read off a capture', () => {
  /** A query with an OPT record in its additional section, as glibc sends one under edns0. */
  function withOpt(name: string, type: number): Buffer {
    const message = dnsMessage(name, type);
    message.writeUInt16BE(1, 10);
    const opt = Buffer.from([0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);
    return Buffer.concat([message, opt]);
  }

  it('says which questions carried one', () => {
    const stub = [127, 0, 0, 53];
    const file = pcap([
      ipv4(stub, udp(53, withOpt('sw1', 1))),
      ipv4(stub, udp(53, dnsMessage('sw1', 28))),
    ]);
    assert.deepEqual(
      pcapQuestions(file).map((one) => [one.qtype, one.opt]),
      [
        ['A', true],
        ['AAAA', false],
      ],
    );
    // An authority record before it, its name a pointer, is walked past to the OPT record.
    const ns = dnsMessage('sw1', 1);
    ns.writeUInt16BE(1, 8);
    ns.writeUInt16BE(1, 10);
    const authority = Buffer.from([0xc0, 0x0c, 0, 2, 0, 1, 0, 0, 0, 60, 0, 2, 0xc0, 0x0c]);
    const opt = Buffer.from([0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(
      pcapQuestions(pcap([ipv4(stub, udp(53, Buffer.concat([ns, authority, opt])))])).map(
        (one) => one.opt,
      ),
      [true],
    );
    // A record that runs past the packet is no OPT record.
    const cut = withOpt('sw1', 1).subarray(0, -9);
    assert.deepEqual(
      pcapQuestions(pcap([ipv4(stub, udp(53, cut))])).map((one) => one.opt),
      [false],
    );
  });
});

describe('P-460: the committed recordings are of the committed rows', () => {
  it('every image’s run replayed the rows file as it is committed, and recorded every answer row', () => {
    const rowsBytes = readFileSync(
      fileURLToPath(new URL('../../test/fixtures/system-names-rows.json', import.meta.url)),
    );
    const recorded = JSON.parse(readFileSync(RECORDINGS, 'utf8')) as RecordingsFile;
    assert.equal(recorded.schema, 3);
    const images = Object.keys(ROWS.images).sort();
    assert.deepEqual(Object.keys(recorded.images).sort(), images);
    for (const image of images) {
      const made = recorded.images[image];
      assert.ok(made !== undefined, image);
      assert.equal(made.rowsDigest, digestOf(rowsBytes), image);
      // The answer rows as they are committed: a row edited since was not what was recorded.
      assert.equal(made.answerRowsDigest, answerRowsDigest(), image);
    }
    for (const image of images) {
      for (const row of ANSWER_ROWS) {
        const found = recorded.answerRecordings.filter((r) => r.id === row.id && r.image === image);
        assert.equal(found.length, 1, `${row.id} in ${image}`);
        const one = found[0];
        assert.ok(one !== undefined, `${row.id} in ${image}`);
        assert.deepEqual(one.wire, row.wire, `${row.id} in ${image}`);
        assert.equal(one.opt.length, row.wire.length, `${row.id} in ${image}`);
        assert.equal(one.outcome, row.outcome, `${row.id} in ${image}`);
      }
    }
    assert.equal(recorded.answerRecordings.length, images.length * ANSWER_ROWS.length);
  });
});

describe('P-460: the walk’s steps, the checks proven before the plan’s answers are set', () => {
  /** A question as the simulator logs it. */
  const logged = (server: string, qname: string, qtype: string): DnsQueryRecord => ({
    seq: 1,
    at: 0,
    server,
    family: 4,
    transport: 'udp',
    client: { address: '127.0.0.1', port: 40_000 },
    portClass: undefined,
    id: 1,
    qname,
    qtype,
    opt: false,
    ednsOptions: [],
    outcome: 'forwarded',
    reply: undefined,
    fault: undefined,
  });

  /** The simulator and the modes process, each saying what was done to it, in one order. */
  function fakes(): { steps: string[]; sim: WalkSimulator; modes: ModesChannel } {
    const steps: string[] = [];
    const sim: WalkSimulator = {
      set(target, behaviour, server) {
        steps.push(`set ${String(server)} ${JSON.stringify(target)} ${JSON.stringify(behaviour)}`);
        return Promise.resolve();
      },
      clearLog() {
        steps.push('clearLog');
        return Promise.resolve();
      },
      log() {
        steps.push('log');
        return Promise.resolve([logged(S1, 'sw1', 'A'), logged('upstream:127.0.0.2', 'sw1', 'A')]);
      },
    };
    const said: Record<ModesRequest['op'], ModesReply> = {
      prepare: { op: 'prepared', walkProven: true, gateProven: false },
      walk: { op: 'walked', route: 'heard', ms: 2 },
      answers: { op: 'answered', modes: modesFor('heard') },
      release: { op: 'released' },
      exit: { op: 'released' },
    };
    const modes: ModesChannel = {
      request<K extends ModesReply['op']>(
        message: ModesRequest,
        op: K,
      ): Promise<Extract<ModesReply, { op: K }>> {
        steps.push(`request ${message.op}`);
        const reply = said[message.op];
        assert.equal(reply.op, op);
        return Promise.resolve(reply as Extract<ModesReply, { op: K }>);
      },
    };
    return { steps, sim, modes };
  }

  it('sets every server back to NXDOMAIN, proves the checks, then sets the plan and clears the log', async () => {
    const { steps, sim, modes } = fakes();
    const recorded = await walkAndModes(
      modes,
      sim,
      [S1, S2],
      () => {
        steps.push('the plan’s answers');
        return Promise.resolve();
      },
      undefined,
    );
    const neutral = JSON.stringify(NEUTRAL);
    assert.deepEqual(NEUTRAL, { reply: replies.nxdomain });
    assert.deepEqual(steps, [
      `set ${S1} {"fallback":true} ${neutral}`,
      `set ${S2} {"fallback":true} ${neutral}`,
      'request prepare',
      'the plan’s answers',
      'clearLog',
      'request walk',
      'log',
      'request answers',
      'request release',
    ]);
    // The wire is what the servers saw after the log was cleared, resolved's upstream aside.
    assert.deepEqual(recorded.walk, {
      route: 'heard',
      wire: [[S1, 'sw1', 'A', 1]],
      opt: [false],
      ms: 2,
    });
    assert.deepEqual(recorded.setup, ['gate mode’s check was not proven by its canary']);
  });

  it('through systemd-resolved, flushes its cache and captures the stub after the plan is set', async () => {
    const { steps, sim, modes } = fakes();
    const recorded = await walkAndModes(
      modes,
      sim,
      [S1],
      () => {
        steps.push('the plan’s answers');
        return Promise.resolve();
      },
      {
        flush() {
          steps.push('flush');
          return Promise.resolve();
        },
        capture() {
          steps.push('capture');
          return Promise.resolve({
            stop() {
              steps.push('capture stop');
              return Promise.resolve([
                { server: STUB, qname: 'sw1', qtype: 'A', transport: 'udp', opt: true } as const,
              ]);
            },
          });
        },
      },
    );
    assert.deepEqual(steps.slice(1), [
      'request prepare',
      'the plan’s answers',
      'clearLog',
      'flush',
      'capture',
      'request walk',
      'capture stop',
      'log',
      'request answers',
      'request release',
    ]);
    assert.deepEqual(recorded.walk.wire, [
      [STUB, 'sw1', 'A', 1],
      [S1, 'sw1', 'A', 1],
    ]);
    assert.deepEqual(recorded.walk.opt, [true, false]);
  });
});

describe('P-460: the build the boxes load', () => {
  const write = (root: string, path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  it('is every tree the script lists as built', () => {
    const listed = bash('printf "%s\\n" "$MS_NAMES_DIFF_BUILT"');
    assert.equal(listed.status, 0);
    const built = listed.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/u)[1])
      .filter((tree) => tree !== undefined);
    assert.deepEqual(built, [...BUILT_TREES]);
  });

  it('is named by every .js file’s path and bytes, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-names-build-'));
    try {
      for (const tree of BUILT_TREES) write(root, `${tree}/a/one.js`, 'one');
      write(root, `${BUILT_TREES[0]}/two.js`, 'two');
      const first = buildDigest(root);
      assert.match(first, /^[0-9a-f]{64}$/u);
      assert.equal(buildDigest(root), first);
      // A map, a declaration, or a file outside the trees is no part of it.
      write(root, `${BUILT_TREES[0]}/two.js.map`, '{}');
      write(root, `${BUILT_TREES[0]}/two.d.ts`, 'x');
      write(root, 'packages/probe/dist/other.js', 'x');
      assert.equal(buildDigest(root), first);
      write(root, `${BUILT_TREES[3]}/a/one.js`, 'one, changed');
      const changed = buildDigest(root);
      assert.notEqual(changed, first);
      write(root, `${BUILT_TREES[3]}/a/one.js`, 'one');
      assert.equal(buildDigest(root), first);
      write(root, `${BUILT_TREES[5]}/three.js`, '');
      assert.notEqual(buildDigest(root), first);
      rmSync(join(root, BUILT_TREES[5]), { recursive: true });
      assert.notEqual(buildDigest(root), first);
      // A tree with no build at all is not one built empty: a package not built is named so.
      const missing = buildDigest(root);
      mkdirSync(join(root, BUILT_TREES[5]), { recursive: true });
      assert.notEqual(buildDigest(root), missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sees a rebuild while a run goes on, though its bytes come back as they were', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ms-names-build-'));
    try {
      for (const tree of BUILT_TREES) write(root, `${tree}/one.js`, 'one');
      const watch = new BuildWatch(root);
      assert.equal(watch.digest, buildDigest(root));
      watch.look('before row a');
      assert.equal(watch.rebuilt(), undefined);
      assert.deepEqual(watch.fields(), { buildDigest: watch.digest });
      await sleep(50);
      // A mutant built and restored: the same bytes, written again.
      write(root, `${BUILT_TREES[0]}/one.js`, 'one');
      assert.equal(buildDigest(root), watch.digest);
      watch.look('before row b');
      watch.look('at the end');
      assert.equal(watch.rebuilt(), 'before row b');
      assert.deepEqual(watch.fields(), { buildDigest: watch.digest, rebuilt: 'before row b' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is found from its own build, at the root the boxes mount', () => {
    const watch = new BuildWatch();
    assert.equal(watch.digest, buildDigest());
    assert.equal(watch.rebuilt(), undefined);
  });
});

describe('the differential’s script: what each image played', () => {
  it('counts S4’s rows and the answer rows by their own lines, and nothing else the replay said', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ms-names-counts-'));
    try {
      const log = join(dir, 'debian12.log');
      writeFileSync(
        log,
        [
          'debian12 aaaaaaaaaaaaaaaa a walked name: nxdomain 4q, walk heard 4q, answer 2q, walk heard 2q (40 ms)',
          'debian12 0123456789abcdef rotate: last-answers-after-silent 4q, walk silent 3q (5050 ms)',
          'debian12 answer-formerr FORMERR from server 1, server 2 answering: plan 2q, walk heard 2q (30 ms)',
          '(node:12) Warning: something the replay did not say of a row',
          'rocky8 aaaaaaaaaaaaaaaa a walked name: nxdomain 4q (40 ms)',
          'debian12 aaaaaaaaaaaaaaa a short id (1 ms)',
          '',
        ].join('\n'),
      );
      assert.deepEqual(bash('ms_names_diff_counts debian12 "$1"', log), {
        status: 0,
        stdout: '2 rows and 1 answer rows\n',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
